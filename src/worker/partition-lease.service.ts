import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { RedisConnection } from '../redis/redis.module';

// Only release a lease we still hold, and only renew one we still hold — otherwise a
// worker that lost a lease (TTL expired while it was slow) could renew or clobber the
// lease a different worker has since acquired for that same partition.
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function leaseKey(partition: number): string {
  return `lease:partition:${partition}`;
}

function activeWorkerKey(workerId: string): string {
  return `workers:active:${workerId}`;
}

export interface PartitionLeaseEvents {
  on(event: 'acquired', listener: (partition: number) => void): this;
  on(event: 'lost', listener: (partition: number) => void): this;
}

@Injectable()
export class PartitionLeaseService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy, PartitionLeaseEvents
{
  readonly workerId = randomUUID();
  private readonly logger = new Logger(PartitionLeaseService.name);
  private readonly partitionCount: number;
  private readonly leaseTtlMs: number;
  private readonly renewMs: number;
  private readonly owned = new Set<number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly redis: RedisConnection,
    private readonly metrics: MetricsService,
    configService: ConfigService,
  ) {
    super();
    this.partitionCount = configService.getOrThrow<number>('STREAM_PARTITIONS');
    this.leaseTtlMs = configService.getOrThrow<number>('PARTITION_LEASE_TTL_MS');
    this.renewMs = configService.getOrThrow<number>('PARTITION_LEASE_RENEW_MS');
  }

  get ownedPartitions(): number[] {
    return [...this.owned];
  }

  async onModuleInit(): Promise<void> {
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logger.error(`Partition lease reconcile failed: ${String(error)}`);
      });
    }, this.renewMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }

    await Promise.all([...this.owned].map((partition) => this.release(partition)));
  }

  private async reconcile(): Promise<void> {
    const client = this.redis.client;
    // The shared connection is created with enableOfflineQueue: false, so a command
    // issued before it first connects is rejected outright instead of queued — wait for
    // 'ready' once rather than risk reconcile() throwing on the very first tick.
    if (client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
      });
    }
    // Renew generously relative to the renew interval so a single missed/slow tick (e.g.
    // a brief Redis hiccup) doesn't make this worker vanish from the active count.
    await client.set(activeWorkerKey(this.workerId), '1', 'PX', this.renewMs * 3);
    const activeWorkerCount = await this.countActiveWorkers();
    const fairShare = Math.max(1, Math.ceil(this.partitionCount / activeWorkerCount));

    for (const partition of [...this.owned]) {
      const renewed = await client.eval(
        RENEW_SCRIPT,
        1,
        leaseKey(partition),
        this.workerId,
        String(this.leaseTtlMs),
      );
      if (renewed !== 1) {
        this.owned.delete(partition);
        this.logger.warn(`Lost lease for partition ${partition} before it could be renewed.`);
        this.emit('lost', partition);
      }
    }

    for (
      let partition = 0;
      this.owned.size < fairShare && partition < this.partitionCount;
      partition += 1
    ) {
      if (this.owned.has(partition)) {
        continue;
      }

      const acquired = await client.set(
        leaseKey(partition),
        this.workerId,
        'PX',
        this.leaseTtlMs,
        'NX',
      );
      if (acquired === 'OK') {
        this.owned.add(partition);
        this.logger.log(`Acquired partition ${partition}.`);
        this.emit('acquired', partition);
      }
    }

    const excessCount = Math.max(0, this.owned.size - fairShare);
    const excess = [...this.owned].sort((a, b) => b - a).slice(0, excessCount);
    for (const partition of excess) {
      await this.release(partition);
    }

    this.metrics.partitionLeasesHeld.set(this.owned.size);
  }

  private async release(partition: number): Promise<void> {
    await this.redis.client.eval(RELEASE_SCRIPT, 1, leaseKey(partition), this.workerId);
    if (this.owned.delete(partition)) {
      this.logger.log(`Released partition ${partition}.`);
      this.emit('lost', partition);
    }
  }

  private async countActiveWorkers(): Promise<number> {
    const client = this.redis.client;
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', 'workers:active:*', 'COUNT', '100');
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');

    return Math.max(count, 1);
  }
}

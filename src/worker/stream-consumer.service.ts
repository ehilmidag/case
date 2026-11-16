import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AreaIndexManager } from '../geofence/area-index.manager';
import { locationStreamKey } from '../locations/partitioner';
import { RedisConnection } from '../redis/redis.module';
import { BatchProcessorService } from './batch-processor.service';
import { PartitionLeaseService } from './partition-lease.service';
import { StreamMessage } from './dlq';

const CONSUMER_GROUP = 'geofence';

type Loop = {
  stop: () => void;
  done: Promise<void>;
};

@Injectable()
export class StreamConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamConsumerService.name);
  private readonly loops = new Map<number, Loop>();
  private readonly batchSize: number;
  private readonly blockMs: number;
  private shuttingDown = false;

  constructor(
    private readonly lease: PartitionLeaseService,
    private readonly redis: RedisConnection,
    private readonly batchProcessor: BatchProcessorService,
    private readonly areaIndexManager: AreaIndexManager,
    configService: ConfigService,
  ) {
    this.batchSize = configService.getOrThrow<number>('WORKER_BATCH_SIZE');
    this.blockMs = configService.getOrThrow<number>('WORKER_BLOCK_MS');
  }

  async onModuleInit(): Promise<void> {
    // Consuming before the geofence index has loaded at least once would make every
    // point in the first batches fail (AreaIndexManager.current throws), which the
    // bisect/DLQ path would misread as poison messages rather than a startup race.
    await this.areaIndexManager.whenReady();

    this.lease.on('acquired', (partition: number) => this.startLoop(partition));
    this.lease.on('lost', (partition: number) => this.stopLoop(partition));

    for (const partition of this.lease.ownedPartitions) {
      this.startLoop(partition);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(
      [...this.loops.values()].map((loop) => {
        loop.stop();
        return loop.done;
      }),
    );
  }

  private startLoop(partition: number): void {
    if (this.loops.has(partition) || this.shuttingDown) {
      return;
    }

    // enableOfflineQueue: true (overriding the shared client's false) lets commands
    // issued before this fresh connection finishes connecting queue up instead of being
    // rejected outright with "Stream isn't writeable".
    const connection = this.redis.client.duplicate({ enableOfflineQueue: true });
    let stopped = false;
    let crashed = false;
    const done = this.runLoop(partition, connection, () => stopped || this.shuttingDown)
      .catch((error: unknown) => {
        crashed = true;
        this.logger.error(`Consumer loop for partition ${partition} crashed: ${String(error)}`);
      })
      .finally(() => {
        connection.disconnect();
        this.loops.delete(partition);
        // An unexpected error (e.g. the stream/group vanishing from under us after a
        // Redis data loss) must not strand this partition forever: without this, recovery
        // would depend entirely on a future 'acquired' event — losing and re-winning the
        // lease — which may never happen again while it stays healthy. As long as we
        // still hold the lease and aren't shutting down, restart instead of waiting for
        // that event. A short delay avoids a tight crash loop if the error persists.
        if (crashed && !stopped) {
          const retryTimer = setTimeout(() => {
            if (!this.shuttingDown && this.lease.ownedPartitions.includes(partition)) {
              this.startLoop(partition);
            }
          }, this.blockMs);
          retryTimer.unref();
        }
      });

    this.loops.set(partition, { stop: () => (stopped = true), done });
  }

  private stopLoop(partition: number): void {
    this.loops.get(partition)?.stop();
  }

  private async runLoop(
    partition: number,
    connection: Redis,
    shouldStop: () => boolean,
  ): Promise<void> {
    const stream = locationStreamKey(partition);
    await this.ensureGroup(connection, stream);
    // A fresh acquisition claims everything pending regardless of idle time: with no
    // previous owner currently alive, whatever is sitting in the PEL is stuck by
    // definition.
    await this.claimStuckMessages(stream, connection, 0);

    // A message that keeps failing (handleSingleMessageFailure leaves it unacked below
    // MAX_DELIVERY_ATTEMPTS) is never redelivered by XREADGROUP — that only returns
    // entries never delivered before ('>'). Without a periodic re-claim, its delivery
    // count would never advance and it would sit in the PEL forever instead of eventually
    // reaching MAX_DELIVERY_ATTEMPTS and moving to the DLQ. The min-idle-time guard keeps
    // this from reclaiming messages a (possibly slow) batch is still legitimately working.
    const reclaimCheckIntervalMs = this.blockMs * 5;
    let lastReclaimCheck = Date.now();

    while (!shouldStop()) {
      if (Date.now() - lastReclaimCheck >= reclaimCheckIntervalMs) {
        lastReclaimCheck = Date.now();
        await this.claimStuckMessages(stream, connection, reclaimCheckIntervalMs);
      }

      const result = (await connection.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        this.lease.workerId,
        'COUNT',
        this.batchSize,
        'BLOCK',
        this.blockMs,
        'STREAMS',
        stream,
        '>',
      )) as Array<[string, StreamMessage[]]> | null;

      if (!result) {
        continue;
      }

      const [[, messages]] = result;
      if (messages.length === 0) {
        continue;
      }

      await this.batchProcessor.process(stream, CONSUMER_GROUP, messages);
    }
  }

  private async ensureGroup(connection: Redis, stream: string): Promise<void> {
    try {
      await connection.xgroup('CREATE', stream, CONSUMER_GROUP, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) {
        throw error;
      }
    }
  }

  private async claimStuckMessages(
    stream: string,
    connection: Redis,
    minIdleMs: number,
  ): Promise<void> {
    let cursor = '0-0';
    for (;;) {
      const [nextCursor, claimed] = (await connection.xautoclaim(
        stream,
        CONSUMER_GROUP,
        this.lease.workerId,
        minIdleMs,
        cursor,
        'COUNT',
        this.batchSize,
      )) as [string, StreamMessage[], string[]];

      cursor = nextCursor;
      if (claimed.length > 0) {
        this.logger.log(`Reclaimed ${claimed.length} pending message(s) on ${stream}.`);
        await this.batchProcessor.process(stream, CONSUMER_GROUP, claimed);
      }

      if (cursor === '0-0') {
        break;
      }
    }
  }
}

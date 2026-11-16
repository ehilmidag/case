import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { RedisConnection } from '../redis/redis.module';
import { locationStreamKey } from './partitioner';

type GroupInfo = Array<string | number | null>;

export class IngestBackpressureException extends ServiceUnavailableException {
  readonly retryAfterSeconds = 1;

  constructor() {
    super({
      statusCode: 503,
      message: 'Location ingestion is temporarily backpressured.',
    });
  }
}

@Injectable()
export class BackpressureMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackpressureMonitor.name);
  private readonly partitionCount: number;
  private readonly maxPending: number;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private pendingMessages = 0;
  private available = false;

  constructor(
    private readonly redis: RedisConnection,
    private readonly metrics: MetricsService,
    configService: ConfigService,
  ) {
    this.partitionCount = configService.getOrThrow<number>('STREAM_PARTITIONS');
    this.maxPending = configService.getOrThrow<number>('BACKPRESSURE_MAX_PENDING');
  }

  get pending(): number {
    return this.pendingMessages;
  }

  assertCapacity(): void {
    if (!this.available || this.pendingMessages >= this.maxPending) {
      throw new IngestBackpressureException();
    }
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.available = false;
        this.logger.error(`Unable to sample stream backpressure: ${String(error)}`);
      });
    }, 1000);
    this.refreshTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  async refresh(): Promise<number> {
    const client = this.redis.client;
    if (client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
      });
    }

    const streamKeys = Array.from({ length: this.partitionCount }, (_, partition) =>
      locationStreamKey(partition),
    );
    const lengthPipeline = client.pipeline();
    for (const stream of streamKeys) {
      lengthPipeline.xlen(stream);
    }
    const lengths = await lengthPipeline.exec();
    if (!lengths) {
      throw new Error('Redis stream length pipeline returned no result.');
    }
    const lengthError = lengths.find(([error]) => error)?.[0];
    if (lengthError) {
      throw lengthError;
    }

    const pendingByStream = new Map<string, number>(streamKeys.map((stream) => [stream, 0]));
    const existingStreams = streamKeys
      .map((stream, index) => ({ stream, length: Number(lengths[index]?.[1] ?? 0) }))
      .filter(({ length }) => length > 0);

    if (existingStreams.length > 0) {
      const groupsPipeline = client.pipeline();
      for (const { stream } of existingStreams) {
        groupsPipeline.call('XINFO', 'GROUPS', stream);
      }
      const groupsResults = await groupsPipeline.exec();
      if (!groupsResults) {
        throw new Error('Redis consumer group pipeline returned no result.');
      }

      const streamsWithoutGroups: string[] = [];
      groupsResults.forEach(([error, result], index) => {
        if (error) {
          throw error;
        }

        const { stream, length } = existingStreams[index];
        const groups = result as GroupInfo[];
        if (groups.length === 0) {
          streamsWithoutGroups.push(stream);
          return;
        }

        for (const group of groups) {
          const lag = readGroupField(group, 'lag');
          pendingByStream.set(stream, (pendingByStream.get(stream) ?? 0) + (lag ?? length));
        }
      });

      if (streamsWithoutGroups.length > 0) {
        const fallbackPipeline = client.pipeline();
        for (const stream of streamsWithoutGroups) {
          fallbackPipeline.xlen(stream);
        }
        const lengthsWithoutGroups = await fallbackPipeline.exec();
        if (!lengthsWithoutGroups) {
          throw new Error('Redis stream length fallback pipeline returned no result.');
        }
        const fallbackError = lengthsWithoutGroups.find(([error]) => error)?.[0];
        if (fallbackError) {
          throw fallbackError;
        }
        streamsWithoutGroups.forEach((stream, index) => {
          pendingByStream.set(stream, Number(lengthsWithoutGroups[index][1]));
        });
      }
    }

    streamKeys.forEach((stream, partition) => {
      this.metrics.streamPendingMessages.set(
        { partition: String(partition) },
        pendingByStream.get(stream) ?? 0,
      );
    });

    const pending = [...pendingByStream.values()].reduce((total, value) => total + value, 0);
    this.pendingMessages = pending;
    this.available = true;
    return pending;
  }
}

function readGroupField(group: GroupInfo, field: string): number | null {
  const index = group.findIndex((value) => value === field);
  if (index < 0 || group[index + 1] === null) {
    return null;
  }

  const value = Number(group[index + 1]);
  return Number.isFinite(value) ? value : null;
}

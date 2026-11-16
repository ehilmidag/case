import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { RedisConnection } from '../redis/redis.module';
import { BackpressureMonitor } from './backpressure-monitor.service';
import { IngestPoint } from './location-payload';
import { locationStreamKey, partitionForUser } from './partitioner';

@Injectable()
export class IngestService {
  private readonly partitionCount: number;
  private readonly streamMaxLength: number;

  constructor(
    private readonly redis: RedisConnection,
    private readonly backpressure: BackpressureMonitor,
    private readonly metrics: MetricsService,
    configService: ConfigService,
  ) {
    this.partitionCount = configService.getOrThrow<number>('STREAM_PARTITIONS');
    this.streamMaxLength = configService.getOrThrow<number>('STREAM_MAXLEN');
  }

  async ingest(points: IngestPoint[]): Promise<number> {
    this.backpressure.assertCapacity();
    if (points.length === 0) {
      return 0;
    }

    const partitions = new Map<number, IngestPoint[]>();
    for (const point of points) {
      const partition = partitionForUser(point.userId, this.partitionCount);
      const partitionPoints = partitions.get(partition) ?? [];
      partitionPoints.push(point);
      partitions.set(partition, partitionPoints);
    }

    const pipeline = this.redis.client.pipeline();
    for (const [partition, partitionPoints] of partitions) {
      const stream = locationStreamKey(partition);
      for (const point of partitionPoints) {
        pipeline.xadd(
          stream,
          'MAXLEN',
          '~',
          String(this.streamMaxLength),
          '*',
          'userId',
          point.userId,
          'lat',
          String(point.latitude),
          'lng',
          String(point.longitude),
          'ts',
          String(point.ts),
          'receivedAt',
          String(Date.now()),
        );
      }
    }

    const results = await pipeline.exec();
    if (!results) {
      throw new Error('Redis location ingest pipeline returned no result.');
    }

    const firstError = results.find(([error]) => error)?.[0];
    if (firstError) {
      throw firstError;
    }

    this.metrics.locationsIngestedTotal.inc(points.length);
    return points.length;
  }
}

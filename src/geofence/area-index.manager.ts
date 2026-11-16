import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { RedisConnection } from '../redis/redis.module';
import { AreaGeometry, GeofenceIndex } from './geofence-index';
import { H3GeofenceIndex } from './h3-geofence-index';
import { RTreeGeofenceIndex } from './rtree-geofence-index';

type AreaIndexRow = {
  id: string;
  geometry: AreaGeometry['geometry'];
  version: string;
};

const AREAS_CHANGED_CHANNEL = 'areas.changed';

@Injectable()
export class AreaIndexManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AreaIndexManager.name);
  private index: GeofenceIndex | undefined;
  // Areas are only ever inserted (update/delete are out of scope), so the row count is a
  // safe signal for "nothing changed since the last load" — unlike MAX(version), it can't
  // be fooled by a lower-version transaction committing after a higher-version one
  // (nextval() is assigned before commit, so commit order can differ from version order).
  // Comparing MAX(version) alone can make that late-committing area permanently invisible:
  // once some later area pushes MAX(version) past it, every future comparison matches and
  // the rebuild that would have picked it up keeps getting skipped.
  private loadedAreaCount: number | undefined;
  private subscriber: Redis | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private readyWaiters: Array<() => void> = [];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisConnection,
    private readonly metrics: MetricsService,
    private readonly configService: ConfigService,
  ) {}

  get current(): GeofenceIndex {
    if (!this.index) {
      throw new Error('Geofence index has not been loaded.');
    }

    return this.index;
  }

  // Lets consumers that must not run before the first load completes (the worker's stream
  // consumer) wait for it explicitly, rather than relying on NestJS's module init ordering.
  async whenReady(): Promise<void> {
    if (this.index) {
      return;
    }

    await new Promise<void>((resolve) => this.readyWaiters.push(resolve));
  }

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.client.duplicate({ enableOfflineQueue: true });
    this.subscriber.on('message', (channel) => {
      if (channel === AREAS_CHANGED_CHANNEL) {
        void this.refresh().catch((error: unknown) => {
          this.logger.error(`Area index refresh after pub/sub failed: ${String(error)}`);
        });
      }
    });
    await this.subscriber.ping();
    await this.subscriber.subscribe(AREAS_CHANGED_CHANNEL);
    await this.refresh();

    const refreshMs = this.configService.getOrThrow<number>('AREA_INDEX_REFRESH_MS');
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.logger.error(`Periodic area index refresh failed: ${String(error)}`);
      });
    }, refreshMs);
    this.refreshTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    if (this.subscriber?.status === 'ready') {
      await this.subscriber.unsubscribe(AREAS_CHANGED_CHANNEL);
      await this.subscriber.quit();
    } else if (this.subscriber) {
      this.subscriber.disconnect();
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.loadAndSwapIndex();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async loadAndSwapIndex(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    let rows: AreaIndexRow[];
    try {
      await queryRunner.connect();
      rows = (await queryRunner.query(
        'SELECT id, ST_AsGeoJSON(geom)::json AS geometry, version::text AS version FROM areas',
      )) as AreaIndexRow[];
    } finally {
      await queryRunner.release();
    }

    if (rows.length === this.loadedAreaCount) {
      return;
    }

    const version = rows.reduce((maximum, area) => Math.max(maximum, Number(area.version)), 0);
    const areas: AreaGeometry[] = rows.map(({ id, geometry }) => ({ id, geometry }));
    const index = this.createIndex();
    index.rebuild(areas, version);
    this.index = index;
    this.loadedAreaCount = rows.length;
    this.metrics.geofenceIndexVersion.set(version);

    if (this.readyWaiters.length > 0) {
      this.readyWaiters.forEach((resolve) => resolve());
      this.readyWaiters = [];
    }
  }

  private createIndex(): GeofenceIndex {
    const kind = this.configService.getOrThrow<'rtree' | 'h3'>('GEOFENCE_INDEX');
    if (kind === 'h3') {
      const resolution = this.configService.getOrThrow<number>('H3_INDEX_RESOLUTION');
      return new H3GeofenceIndex(resolution);
    }

    return new RTreeGeofenceIndex();
  }
}

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { AreaIndexManager } from '../geofence/area-index.manager';
import { locationStreamKey, partitionForUser } from '../locations/partitioner';
import { RedisConnection } from '../redis/redis.module';
import { FaultInjector, FaultPoint } from './fault-injector';

// Faz 10.2: for each crash point in plan.md's worker crash table (Bölüm 7), force the
// worker to throw at that exact point for one specific message, then confirm that once
// the message is redelivered (via the periodic XAUTOCLAIM reclaim, exactly like a real
// crash-then-restart), the database ends up in the same state a single clean run would
// have produced. FaultInjector is a no-op in production — it only ever throws for a
// (point, messageId) pair this spec explicitly arms.
type AreaEntryRow = {
  user_id: string;
  area_id: string;
  entered_at: Date;
  exited_at: Date | null;
};

type UserAreaStateRow = {
  user_id: string;
  area_id: string;
};

describe('worker crash recovery (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let redisConnection: RedisConnection;
  let faultInjector: FaultInjector;
  let areaId: string;
  let nextStreamId = Date.now();

  beforeAll(async () => {
    const postgisImage =
      process.arch === 'arm64' ? 'ghcr.io/baosystems/postgis:16-3.4' : 'postgis/postgis:16-3.4';
    postgres = await new PostgreSqlContainer(postgisImage)
      .withDatabase('locations')
      .withUsername('app')
      .withPassword('app')
      .withHealthCheck({
        test: [
          'CMD-SHELL',
          'PGPASSWORD=app pg_isready --host localhost --username app --dbname locations',
        ],
        interval: 250,
        timeout: 1000,
        retries: 1000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    redis = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.DATABASE_READ_URL = '';
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.STREAM_PARTITIONS = '1';
    process.env.WORKER_BLOCK_MS = '100';
    process.env.PARTITION_LEASE_TTL_MS = '2000';
    process.env.PARTITION_LEASE_RENEW_MS = '300';
    process.env.AREA_INDEX_REFRESH_MS = '300';
    process.env.EXIT_CONFIRM_POINTS = '3';
    process.env.EXIT_CONFIRM_MS = '300000';
    process.env.SIGNAL_TIMEOUT_MS = '600000';
    process.env.STATE_REFRESH_MS = '500';
    process.env.FORCE_EVAL_MS = '100';
    process.env.SWEEPER_INTERVAL_MS = '300000';
    process.env.H3_SKIP_RESOLUTION = '11';
    process.env.MAX_DELIVERY_ATTEMPTS = '5';

    const { createDatabaseOptions } = await import('../database/database-options');
    const migrationDataSource = new DataSource(
      createDatabaseOptions({
        DATABASE_URL: postgres.getConnectionUri(),
        DATABASE_READ_URL: '',
      }),
    );
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    await migrationDataSource.destroy();

    const { AppWorkerModule } = await import('../app-worker.module');
    const testingModule = await Test.createTestingModule({ imports: [AppWorkerModule] }).compile();
    app = testingModule.createNestApplication();
    dataSource = app.get(DataSource);
    await app.init();

    redisConnection = app.get(RedisConnection);
    faultInjector = app.get(FaultInjector);

    const [area] = (await dataSource.query(
      `INSERT INTO areas (name, geom, version)
       VALUES (
         'crash-recovery-area',
         ST_GeomFromText('POLYGON((29 41,29.01 41,29.01 41.01,29 41.01,29 41))', 4326),
         nextval('area_set_version_seq')
       )
       RETURNING id`,
    )) as Array<{ id: string }>;
    areaId = area.id;

    await redisConnection.client.publish('areas.changed', '1');

    const areaIndexManager = app.get(AreaIndexManager);
    await waitForCondition(
      () =>
        Promise.resolve(areaIndexManager.current.findContaining(41.005, 29.005).includes(areaId)),
      'area index did not pick up the crash-recovery area',
      5000,
    );
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it.each<[FaultPoint, string]>([
    ['before-transaction', 'crash-before-tx-user'],
    ['during-transaction', 'crash-during-tx-user'],
    ['after-commit', 'crash-after-commit-user'],
    ['after-redis-update', 'crash-after-redis-user'],
  ])(
    'recovers the correct final state after a simulated crash %s',
    async (point, userId) => {
      const id = `${nextStreamId}-0`;
      nextStreamId += 1;

      faultInjector.arm(point, id);
      await sendPointWithId(id, userId, 41.005, 29.005, Date.now());

      const entries = await waitForEntries(userId, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0].area_id).toBe(areaId);
      expect(entries[0].exited_at).toBeNull();

      const states = (await dataSource.query(
        'SELECT user_id, area_id FROM user_area_state WHERE user_id = $1',
        [userId],
      )) as UserAreaStateRow[];
      expect(states).toHaveLength(1);

      // Give a potential (buggy) duplicate-on-redelivery a moment to show up.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(await readEntries(userId)).toHaveLength(1);
    },
    20000,
  );

  async function sendPointWithId(
    id: string,
    userId: string,
    lat: number,
    lng: number,
    ts: number,
  ): Promise<void> {
    const partition = partitionForUser(userId, 1);
    const stream = locationStreamKey(partition);
    await redisConnection.client.xadd(
      stream,
      id,
      'userId',
      userId,
      'lat',
      String(lat),
      'lng',
      String(lng),
      'ts',
      String(ts),
      'receivedAt',
      String(Date.now()),
    );
  }

  async function readEntries(userId: string): Promise<AreaEntryRow[]> {
    return dataSource.query(
      'SELECT user_id, area_id, entered_at, exited_at FROM area_entries WHERE user_id = $1 ORDER BY entered_at',
      [userId],
    );
  }

  async function waitForEntries(userId: string, count: number): Promise<AreaEntryRow[]> {
    let entries: AreaEntryRow[] = [];
    await waitForCondition(
      async () => {
        entries = await readEntries(userId);
        return entries.length >= count;
      },
      `expected at least ${count} entr${count === 1 ? 'y' : 'ies'} for ${userId}`,
    );
    return entries;
  }

  async function waitForCondition(
    check: () => Promise<boolean>,
    message: string,
    timeoutMs = 15000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting: ${message}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
});

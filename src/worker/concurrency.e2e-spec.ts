import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { BatchProcessorService } from './batch-processor.service';
import { StreamMessage } from './dlq';

// Faz 10.3: "aynı partition'ı iki worker'a aynı anda işlet (zombi senaryosu); çift giriş
// kaydı oluşmamalı." A real zombie (a worker whose lease TTL quietly expired while it was
// still mid-batch, racing a second worker that just claimed the same now-unowned
// partition) is a timing-dependent state that's flaky to reproduce by chasing real Redis
// TTLs. Instead this spec forces the worst case directly and deterministically: two fully
// independent worker apps (separate BatchProcessorService instances, separate DB
// connections — exactly what two OS processes would be) call `.process()` on the byte-for-
// byte IDENTICAL stream message at the same instant via Promise.all. If partition leasing
// ever fails to prevent this, the schema's own guarantees (the `area_entries` unique
// constraint on (user_id, area_id, entered_at), and `user_area_state`'s primary key on
// (user_id, area_id)) are the last line of defense — this is what the test actually proves.
type AreaEntryRow = {
  user_id: string;
  area_id: string;
  entered_at: Date;
};

describe('worker concurrency / zombie partition (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let appA: INestApplication;
  let appB: INestApplication;
  let dataSource: DataSource;
  let areaId: string;

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
    process.env.WORKER_BLOCK_MS = '5000';
    process.env.PARTITION_LEASE_TTL_MS = '2000';
    process.env.PARTITION_LEASE_RENEW_MS = '300';
    process.env.AREA_INDEX_REFRESH_MS = '60000';
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

    // Inserted before either app starts, so both apps' AreaIndexManager pick it up on
    // their very first (startup) refresh — no pub/sub race to wait out here.
    const [area] = (await migrationDataSource.query(
      `INSERT INTO areas (name, geom, version)
       VALUES (
         'concurrency-e2e-area',
         ST_GeomFromText('POLYGON((29 41,29.01 41,29.01 41.01,29 41.01,29 41))', 4326),
         nextval('area_set_version_seq')
       )
       RETURNING id`,
    )) as Array<{ id: string }>;
    areaId = area.id;
    await migrationDataSource.destroy();

    const { AppWorkerModule } = await import('../app-worker.module');
    const moduleA = await Test.createTestingModule({ imports: [AppWorkerModule] }).compile();
    appA = moduleA.createNestApplication();
    dataSource = appA.get(DataSource);
    await appA.init();

    const moduleB = await Test.createTestingModule({ imports: [AppWorkerModule] }).compile();
    appB = moduleB.createNestApplication();
    await appB.init();
  }, 180000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it('two workers processing the identical message at once still produce exactly one entry', async () => {
    const userId = 'zombie-concurrency-user';
    const ts = Date.now();
    const message: StreamMessage = [
      `${ts}-0`,
      [
        'userId',
        userId,
        'lat',
        '41.005',
        'lng',
        '29.005',
        'ts',
        String(ts),
        'receivedAt',
        String(ts),
      ],
    ];

    const batchProcessorA = appA.get(BatchProcessorService);
    const batchProcessorB = appB.get(BatchProcessorService);
    const stream = 'locations:0';

    await Promise.all([
      batchProcessorA.process(stream, 'geofence', [message]),
      batchProcessorB.process(stream, 'geofence', [message]),
    ]);

    const entries = (await dataSource.query(
      'SELECT user_id, area_id, entered_at FROM area_entries WHERE user_id = $1',
      [userId],
    )) as AreaEntryRow[];
    expect(entries).toHaveLength(1);
    expect(entries[0].area_id).toBe(areaId);

    const states = await dataSource.query(
      'SELECT 1 FROM user_area_state WHERE user_id = $1 AND area_id = $2',
      [userId, areaId],
    );
    expect(states).toHaveLength(1);
  }, 30000);
});

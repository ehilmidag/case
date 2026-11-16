import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { locationStreamKey, partitionForUser } from '../locations/partitioner';
import { RedisConnection } from '../redis/redis.module';

// Faz 10.4: "İşlem ortasında FLUSHALL çalıştır. Son durum değişmemeli." Redis holds only
// disposable state here (partition leases, the active-worker set, and the per-user
// staleness filter) — PostgreSQL is the single source of truth for entries/exits (plan.md
// Bölüm 4, "Tutarlılık Garantileri"). Wiping Redis mid-stream should cost nothing but a
// brief lease re-acquisition blip; it must not corrupt or lose anything already committed,
// and processing of further points must still converge to the correct final state.
type AreaEntryRow = {
  user_id: string;
  area_id: string;
  entered_at: Date;
  exited_at: Date | null;
  exit_reason: string | null;
};

describe('worker resilience to Redis data loss (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let redisConnection: RedisConnection;
  let areaId: string;
  const userId = 'redis-loss-user';

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
    process.env.WORKER_BLOCK_MS = '200';
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

    const { createDatabaseOptions } = await import('../database/database-options');
    const migrationDataSource = new DataSource(
      createDatabaseOptions({
        DATABASE_URL: postgres.getConnectionUri(),
        DATABASE_READ_URL: '',
      }),
    );
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();

    // Inserted before app.init() so the worker's first AreaIndexManager load already
    // includes it — no pub/sub race to wait out.
    const [area] = (await migrationDataSource.query(
      `INSERT INTO areas (name, geom, version)
       VALUES (
         'redis-loss-area',
         ST_GeomFromText('POLYGON((29 41,29.01 41,29.01 41.01,29 41.01,29 41))', 4326),
         nextval('area_set_version_seq')
       )
       RETURNING id`,
    )) as Array<{ id: string }>;
    areaId = area.id;
    await migrationDataSource.destroy();

    const { AppWorkerModule } = await import('../app-worker.module');
    const testingModule = await Test.createTestingModule({ imports: [AppWorkerModule] }).compile();
    app = testingModule.createNestApplication();
    dataSource = app.get(DataSource);
    await app.init();

    redisConnection = app.get(RedisConnection);
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it('keeps processing correctly across a FLUSHALL mid-stream', async () => {
    const base = Date.now();

    await sendPoint(41.005, 29.005, base); // inside: creates an entry
    let entries = await waitForEntries(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].exited_at).toBeNull();

    // Wipes partition leases, the active-worker set, and every per-user staleness filter —
    // everything the worker keeps in Redis. Nothing in Postgres is touched.
    await redisConnection.client.flushall();

    // The lease reconcile loop (every PARTITION_LEASE_RENEW_MS) should notice, silently
    // re-acquire the now-unowned partition, and resume consuming without manual
    // intervention — give it a couple of cycles before sending more points.
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));

    // Three consecutive outside points confirm an exit (EXIT_CONFIRM_POINTS=3). The
    // per-user Redis filter was just wiped, so every one of these is fully re-evaluated
    // against the real PostgreSQL state rather than skipped — which is exactly the
    // point: correctness survives even with zero cache assistance.
    await sendPoint(41.02, 29.005, base + 1000);
    await sendPoint(41.02, 29.005, base + 2000);
    await sendPoint(41.02, 29.005, base + 3000);

    await waitForCondition(async () => {
      entries = await readEntries();
      return entries.length === 1 && entries[0].exit_reason === 'left';
    }, 'expected the entry to be exited after three post-FLUSHALL outside points');

    entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].area_id).toBe(areaId);
    expect(entries[0].exited_at).not.toBeNull();

    const states = await dataSource.query('SELECT 1 FROM user_area_state WHERE user_id = $1', [
      userId,
    ]);
    expect(states).toHaveLength(0);
  }, 60000);

  async function sendPoint(lat: number, lng: number, ts: number): Promise<void> {
    const partition = partitionForUser(userId, 1);
    const stream = locationStreamKey(partition);
    await redisConnection.client.xadd(
      stream,
      '*',
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

  async function readEntries(): Promise<AreaEntryRow[]> {
    return dataSource.query(
      'SELECT user_id, area_id, entered_at, exited_at, exit_reason FROM area_entries WHERE user_id = $1 ORDER BY entered_at',
      [userId],
    );
  }

  async function waitForEntries(count: number): Promise<AreaEntryRow[]> {
    let entries: AreaEntryRow[] = [];
    await waitForCondition(
      async () => {
        entries = await readEntries();
        return entries.length >= count;
      },
      `expected at least ${count} entr${count === 1 ? 'y' : 'ies'} for ${userId}`,
    );
    return entries;
  }

  async function waitForCondition(
    check: () => Promise<boolean>,
    message: string,
    timeoutMs = 45000,
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

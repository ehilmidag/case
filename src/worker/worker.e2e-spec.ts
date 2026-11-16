import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { RedisConnection } from '../redis/redis.module';
import { locationStreamKey, partitionForUser } from '../locations/partitioner';
import { AreaIndexManager } from '../geofence/area-index.manager';

type AreaEntryRow = {
  user_id: string;
  area_id: string;
  entered_at: Date;
  exited_at: Date | null;
  exit_reason: string | null;
};

describe('worker end-to-end (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let redisConnection: RedisConnection;
  let areaId: string;
  const userId = 'worker-e2e-user';

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
    process.env.AREA_INDEX_REFRESH_MS = '300';
    process.env.EXIT_CONFIRM_POINTS = '3';
    process.env.EXIT_CONFIRM_MS = '300000';
    process.env.SIGNAL_TIMEOUT_MS = '1000';
    process.env.STATE_REFRESH_MS = '500';
    process.env.FORCE_EVAL_MS = '100';
    process.env.SWEEPER_INTERVAL_MS = '300';
    process.env.H3_SKIP_RESOLUTION = '11';

    // Production never hits this ordering problem: a separate migration-init container
    // runs to completion before the worker starts, so by the time AreaIndexManager's
    // onModuleInit queries `areas`, the schema already exists. Here there is no such
    // separate step, and AreaIndexManager (unlike the DatabaseModule-only modules the
    // other e2e specs boot) queries the schema eagerly during app.init(), so migrations
    // must run on their own connection first.
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

    const [area] = (await dataSource.query(
      `INSERT INTO areas (name, geom, version)
       VALUES (
         'worker-e2e-area',
         ST_GeomFromText('POLYGON((29 41,29.01 41,29.01 41.01,29 41.01,29 41))', 4326),
         nextval('area_set_version_seq')
       )
       RETURNING id`,
    )) as Array<{ id: string }>;
    areaId = area.id;

    await redisConnection.client.publish('areas.changed', '1');

    // The pub/sub refresh and the periodic AREA_INDEX_REFRESH_MS timer both race
    // asynchronously against this beforeAll returning. Without waiting for the new
    // area to actually land in the worker's live index, the first test's points can be
    // evaluated against the still-empty index loaded at app.init() and never detected as
    // "inside" — a one-shot miss, since a point is only ever evaluated once.
    const areaIndexManager = app.get(AreaIndexManager);
    await waitFor(() =>
      Promise.resolve(areaIndexManager.current.findContaining(41.005, 29.005).includes(areaId)),
    );
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it('creates an entry once a point lands inside the area', async () => {
    // The area spans lng [29, 29.01] x lat [41, 41.01].
    await sendPoint(41.02, 29.005, Date.now()); // outside: lat past the area's edge
    await sendPoint(41.005, 29.005, Date.now() + 1000); // inside

    const entries = await waitForEntries(userId, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].area_id).toBe(areaId);
    expect(entries[0].exited_at).toBeNull();
  }, 60000);

  it('produces a single entry for points that flicker across the boundary', async () => {
    const base = Date.now();
    // Inside, outside, inside, outside, inside — none of these runs reach
    // EXIT_CONFIRM_POINTS (3) consecutively, so the original entry should never close.
    await sendPoint(41.005, 29.005, base + 2000);
    await sendPoint(41.02, 29.005, base + 3000);
    await sendPoint(41.005, 29.005, base + 4000);
    await sendPoint(41.02, 29.005, base + 5000);
    await sendPoint(41.005, 29.005, base + 6000);

    await waitForCondition(async () => {
      const entries = await readEntries(userId);
      return entries.length === 1 && entries[0].exited_at === null;
    }, 'expected exactly one still-open entry after boundary flicker');

    const entries = await readEntries(userId);
    expect(entries).toHaveLength(1);
  }, 60000);

  it('closes the entry with exit_reason=timeout once the signal goes quiet', async () => {
    // No further points are sent for this user; SIGNAL_TIMEOUT_MS (1000ms) then the
    // sweeper (every 300ms) should close the still-open entry as a timeout exit.
    await waitForCondition(async () => {
      const entries = await readEntries(userId);
      return entries.length === 1 && entries[0].exit_reason === 'timeout';
    }, 'expected the open entry to be closed with exit_reason=timeout');

    const entries = await readEntries(userId);
    expect(entries[0].exited_at).not.toBeNull();

    const states = await dataSource.query('SELECT 1 FROM user_area_state WHERE user_id = $1', [
      userId,
    ]);
    expect(states).toHaveLength(0);
  }, 60000);

  it('reprocessing the exact same point twice does not create a duplicate entry', async () => {
    // Covers the crash-recovery guarantee from plan.md's table ("Redis güncellemesi ile ack
    // arasında [çökme]: ts <= last_ts filtresi noktayı atlar"): if a point is ever
    // evaluated more than once for any reason (redelivery after a crash before ack, a
    // retried bisect half, etc.), the second evaluation must be a no-op rather than a
    // second entry. Sending the identical point twice exercises that guarantee end-to-end
    // without needing to hook into the exact crash instant. Run last, and with its own
    // userId, so it cannot shift the timing the earlier, shared-userId tests depend on.
    const idempotentUserId = 'worker-e2e-idempotent-user';
    const ts = Date.now();
    await sendPointFor(idempotentUserId, 41.005, 29.005, ts);
    await sendPointFor(idempotentUserId, 41.005, 29.005, ts);

    const entries = await waitForEntries(idempotentUserId, 1);
    expect(entries).toHaveLength(1);

    // Give a potential (buggy) duplicate a moment to show up before declaring success.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(await readEntries(idempotentUserId)).toHaveLength(1);
  }, 60000);

  it('a point delivered out of order after an exit does not create a phantom entry', async () => {
    // Covers Faz 10.1's "sırası karışmış noktalar çift kayıt üretmemeli": simulate network
    // reordering by sending a point whose ts falls BETWEEN an entry and its exit, but only
    // after the exit has already been confirmed and committed. Without the Redis filter's
    // `ts <= filter.ts` staleness guard, this late point would look like a fresh "entering
    // the area" transition (the area isn't in the current state anymore) and create a
    // second, incorrect entry. Own userId, run last, for the same reason as the test above.
    const reorderUserId = 'worker-e2e-reorder-user';
    const base = Date.now();
    await sendPointFor(reorderUserId, 41.005, 29.005, base); // inside: creates an entry
    await sendPointFor(reorderUserId, 41.02, 29.005, base + 1000); // outside #1
    await sendPointFor(reorderUserId, 41.02, 29.005, base + 2000); // outside #2
    await sendPointFor(reorderUserId, 41.02, 29.005, base + 3000); // outside #3: confirms exit

    await waitForCondition(async () => {
      const entries = await readEntries(reorderUserId);
      return entries.length === 1 && entries[0].exited_at !== null;
    }, 'expected the entry to be exited after three consecutive outside points');

    await sendPointFor(reorderUserId, 41.005, 29.005, base + 500);

    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(await readEntries(reorderUserId)).toHaveLength(1);
  }, 60000);

  async function sendPoint(lat: number, lng: number, ts: number): Promise<void> {
    await sendPointFor(userId, lat, lng, ts);
  }

  async function sendPointFor(user: string, lat: number, lng: number, ts: number): Promise<void> {
    const partition = partitionForUser(user, 1);
    const stream = locationStreamKey(partition);
    await redisConnection.client.xadd(
      stream,
      '*',
      'userId',
      user,
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

  async function readEntries(user: string): Promise<AreaEntryRow[]> {
    return dataSource.query(
      'SELECT user_id, area_id, entered_at, exited_at, exit_reason FROM area_entries WHERE user_id = $1 ORDER BY entered_at',
      [user],
    );
  }

  async function waitForEntries(user: string, count: number): Promise<AreaEntryRow[]> {
    let entries: AreaEntryRow[] = [];
    await waitForCondition(
      async () => {
        entries = await readEntries(user);
        return entries.length >= count;
      },
      `expected at least ${count} entr${count === 1 ? 'y' : 'ies'} for ${user}`,
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

  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    await waitForCondition(check, 'initial readiness check', 5000);
  }
});

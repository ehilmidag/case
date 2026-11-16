import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

type ExplainPlanNode = {
  'Relation Name'?: string;
  Plans?: ExplainPlanNode[];
};

function collectRelationNames(node: ExplainPlanNode, names: Set<string>): void {
  if (node['Relation Name']) {
    names.add(node['Relation Name']);
  }
  for (const child of node.Plans ?? []) {
    collectRelationNames(child, names);
  }
}

describe('logs API (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let dataSource: DataSource;

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
    // AppApiModule also wires in AreasModule and LocationsModule, both of which touch
    // the global RedisModule at startup (LocationsModule's BackpressureMonitor connects
    // eagerly in onModuleInit), so this suite needs a real Redis too, not just Postgres.
    redis = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.DATABASE_READ_URL = '';
    process.env.REDIS_URL = redis.getConnectionUrl();

    const { AppApiModule } = await import('../app-api.module');
    const testingModule = await Test.createTestingModule({ imports: [AppApiModule] }).compile();
    app = testingModule.createNestApplication();
    dataSource = app.get(DataSource);
    await app.init();
    await dataSource.runMigrations();
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  async function insertEntry(
    userId: string,
    areaId: string,
    enteredAt: Date,
    exitedAt: Date | null = null,
    exitReason: string | null = null,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO area_entries (user_id, area_id, entered_at, exited_at, exit_reason, area_set_version)
       VALUES ($1, $2::uuid, $3, $4, $5, 1)`,
      [userId, areaId, enteredAt, exitedAt, exitReason],
    );
  }

  it('filters by userId and returns the planned response shape', async () => {
    const userId = `logs-user-${randomUUID()}`;
    const areaId = randomUUID();
    const enteredAt = new Date('2026-11-10T12:00:00.000Z');
    const exitedAt = new Date('2026-11-10T12:30:00.000Z');
    await insertEntry(userId, areaId, enteredAt, exitedAt, 'left');
    await insertEntry(`other-${randomUUID()}`, areaId, enteredAt);

    const response = await request(app.getHttpServer())
      .get('/logs')
      .query({ userId, from: '2026-11-01T00:00:00.000Z' })
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      userId,
      areaId,
      entryTime: enteredAt.toISOString(),
      exitTime: exitedAt.toISOString(),
      exitReason: 'left',
    });
    expect(response.body.nextCursor).toBeNull();
  });

  it('filters by areaId and by an explicit from/to window', async () => {
    const areaId = randomUUID();
    const userId = `logs-area-user-${randomUUID()}`;
    await insertEntry(userId, areaId, new Date('2026-06-01T00:00:00.000Z'));
    await insertEntry(userId, areaId, new Date('2026-11-05T00:00:00.000Z'));
    await insertEntry(userId, randomUUID(), new Date('2026-11-05T00:00:00.000Z'));

    const response = await request(app.getHttpServer())
      .get('/logs')
      .query({
        areaId,
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-10T00:00:00.000Z',
      })
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ areaId, entryTime: '2026-11-05T00:00:00.000Z' });
  });

  it('pages through results with a stable (entered_at, id) keyset cursor', async () => {
    const userId = `logs-paging-user-${randomUUID()}`;
    const areaId = randomUUID();
    const base = new Date('2026-11-12T00:00:00.000Z').getTime();
    for (let i = 0; i < 3; i += 1) {
      await insertEntry(userId, areaId, new Date(base + i * 1000));
    }

    const firstPage = await request(app.getHttpServer())
      .get('/logs')
      .query({ userId, from: '2026-11-01T00:00:00.000Z', limit: 2 })
      .expect(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.items[0].entryTime).toBe(new Date(base + 2000).toISOString());
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app.getHttpServer())
      .get('/logs')
      .query({
        userId,
        from: '2026-11-01T00:00:00.000Z',
        limit: 2,
        cursor: firstPage.body.nextCursor,
      })
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.items[0].entryTime).toBe(new Date(base).toISOString());
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it('defaults to the last 30 days when neither from nor to is given', async () => {
    const userId = `logs-default-window-user-${randomUUID()}`;
    const areaId = randomUUID();
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await insertEntry(userId, areaId, old);
    await insertEntry(userId, areaId, recent);

    const response = await request(app.getHttpServer()).get('/logs').query({ userId }).expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].entryTime).toBe(recent.toISOString());
  });

  it('rejects an invalid cursor with 400', async () => {
    await request(app.getHttpServer()).get('/logs').query({ cursor: 'not-a-cursor' }).expect(400);
  });

  it('prunes to the queried partition instead of scanning every month', async () => {
    const userId = `logs-pruning-user-${randomUUID()}`;
    const areaId = randomUUID();
    // The migration creates the current month plus the next three; these two are at
    // least one full partition apart as long as the suite runs within that window.
    await insertEntry(userId, areaId, new Date('2026-11-05T00:00:00.000Z'));
    await insertEntry(userId, areaId, new Date('2027-02-05T00:00:00.000Z'));

    const [plan] = (await dataSource.query(
      `EXPLAIN (FORMAT JSON) SELECT id, user_id, area_id, entered_at, exited_at, exit_reason
       FROM area_entries
       WHERE user_id = $1 AND entered_at >= $2 AND entered_at < $3
       ORDER BY entered_at DESC, id DESC
       LIMIT 50`,
      [userId, new Date('2026-11-01T00:00:00.000Z'), new Date('2026-12-01T00:00:00.000Z')],
    )) as Array<{ 'QUERY PLAN': [{ Plan: ExplainPlanNode }] }>;

    const relationNames = new Set<string>();
    collectRelationNames(plan['QUERY PLAN'][0].Plan, relationNames);

    expect(relationNames).toContain('area_entries_2026_11');
    expect(relationNames).not.toContain('area_entries_2027_02');
  });

  describe('with 1,000,000 seeded rows', () => {
    const targetUserId = 'logs-perf-user-500';

    // Seeding is its own beforeAll, on a generous timeout: how long a bulk INSERT of a
    // million rows into three indexes takes depends on host/Docker load at the moment —
    // measured standalone on arm64-native Postgres with nothing else running, it already
    // takes ~2 minutes on this hardware, and a busy machine can push that well past 5 —
    // and that variance has nothing to do with the thing actually being asserted below
    // (confirmed separately to run in single-digit milliseconds). Folding the seed into
    // the `it()` block made a slow moment register as a failure of the 50ms query-time
    // assertion rather than what it actually was.
    beforeAll(async () => {
      await dataSource.query(`
        INSERT INTO area_entries (user_id, area_id, entered_at, area_set_version)
        SELECT
          'logs-perf-user-' || (n % 1000),
          gen_random_uuid(),
          now() - (n || ' seconds')::interval,
          1
        FROM generate_series(1, 1000000) AS n
      `);
    }, 600000);

    it('keeps a filtered page query under 50ms', async () => {
      const [explained] = (await dataSource.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id, user_id, area_id, entered_at, exited_at, exit_reason
         FROM area_entries
         WHERE user_id = $1
         ORDER BY entered_at DESC, id DESC
         LIMIT 50`,
        [targetUserId],
      )) as Array<{ 'QUERY PLAN': [{ 'Execution Time': number }] }>;

      const executionTimeMs = explained['QUERY PLAN'][0]['Execution Time'];
      expect(executionTimeMs).toBeLessThan(50);
    }, 10000);
  });
});

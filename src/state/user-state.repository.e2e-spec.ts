import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../database/database-options';
import { RedisConnection } from '../redis/redis.module';
import { RedisFilter } from './redis-filter';
import { UserStateRepository } from './user-state.repository';
import { StateRow, transition, TransitionConfig } from './transition';

const transitionConfig: TransitionConfig = {
  exitConfirmPoints: 3,
  exitConfirmMs: 30_000,
  stateRefreshMs: 300_000,
};

async function applyHistory(
  repository: UserStateRepository,
  areaId: string,
  userId: string,
  timestamps: Date[],
): Promise<void> {
  let state: StateRow[] = [];
  for (const [index, ts] of timestamps.entries()) {
    const matchedAreaIds = index === 0 ? [areaId] : [];
    const changes = transition(state, { ts }, matchedAreaIds, transitionConfig);
    await repository.transaction((manager) =>
      repository.applyChanges(manager, userId, { ...changes, areaSetVersion: 1 }),
    );
    state = changes.upserts;
  }
}

describe('UserStateRepository (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let dataSource: DataSource;
  let repository: UserStateRepository;
  let redisConnection: RedisConnection;
  let redisFilter: RedisFilter;
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
    const redisConfig = new ConfigService({
      REDIS_URL: redis.getConnectionUrl(),
      USER_FILTER_TTL_S: 3600,
    });
    redisConnection = new RedisConnection(redisConfig);
    if (redisConnection.client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        redisConnection.client.once('ready', resolve);
        redisConnection.client.once('error', reject);
      });
    }
    redisFilter = new RedisFilter(redisConnection, redisConfig);

    dataSource = new DataSource(
      createDatabaseOptions({
        DATABASE_URL: postgres.getConnectionUri(),
        DATABASE_READ_URL: '',
      }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    repository = new UserStateRepository(dataSource);

    const [area] = (await dataSource.query(
      `INSERT INTO areas (name, geom, version)
       VALUES (
         'state-test',
         ST_GeomFromText('POLYGON((29 41,29.01 41,29.01 41.01,29 41.01,29 41))', 4326),
         nextval('area_set_version_seq')
       )
       RETURNING id`,
    )) as Array<{ id: string }>;
    areaId = area.id;
  }, 180000);

  afterAll(async () => {
    await redisConnection?.onModuleDestroy();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it('locks and loads state rows and applies exits/upserts/deletes atomically', async () => {
    const userId = 'repository-user';
    const enteredAt = new Date('2026-11-14T12:00:00.000Z');
    const initial = transition([], { ts: enteredAt }, [areaId], transitionConfig);

    await repository.transaction(async (manager) => {
      await repository.applyChanges(manager, userId, {
        ...initial,
        areaSetVersion: 1,
      });
    });

    const loaded = await repository.transaction((manager) =>
      repository.lockAndLoad(manager, [userId]),
    );
    expect(loaded.get(userId)).toEqual([
      {
        areaId,
        enteredAt,
        lastInsideAt: enteredAt,
        outsideCount: 0,
        firstOutsideAt: null,
      },
    ]);

    const firstOutside = new Date('2026-11-14T12:00:05.000Z');
    const secondOutside = new Date('2026-11-14T12:00:10.000Z');
    const thirdOutside = new Date('2026-11-14T12:00:15.000Z');
    let currentState: StateRow[] = loaded.get(userId) ?? [];

    for (const ts of [firstOutside, secondOutside, thirdOutside]) {
      const changes = transition(currentState, { ts }, [], transitionConfig);
      await repository.transaction((manager) =>
        repository.applyChanges(manager, userId, { ...changes, areaSetVersion: 1 }),
      );
      currentState = changes.upserts;
    }

    const [entry] = await repository.readEntries(userId);
    expect(entry.enteredAt.toISOString()).toBe(enteredAt.toISOString());
    expect(entry.exitedAt?.toISOString()).toBe(firstOutside.toISOString());
    expect(entry.exitReason).toBe('left');
    await expect(repository.readStates(userId)).resolves.toHaveLength(0);
  });

  it('preserves the same database result when Redis filter state is empty', async () => {
    const firstUserId = 'replay-with-filter';
    const secondUserId = 'replay-with-empty-filter';
    const timestamps = [0, 5_000, 10_000, 15_000].map(
      (offset) => new Date(Date.UTC(2026, 10, 14, 14, 0, 0) + offset),
    );

    await redisFilter.update({
      userId: firstUserId,
      ts: timestamps[0].getTime(),
      cell: 'test-cell',
    });
    await applyHistory(repository, areaId, firstUserId, timestamps);
    const firstEntries = await repository.readEntries(firstUserId);

    await redisConnection.client.flushdb();
    await applyHistory(repository, areaId, secondUserId, timestamps);
    const secondEntries = await repository.readEntries(secondUserId);

    expect(secondEntries).toHaveLength(firstEntries.length);
    expect(secondEntries[0].enteredAt.toISOString()).toBe(firstEntries[0].enteredAt.toISOString());
    expect(secondEntries[0].exitedAt?.toISOString()).toBe(firstEntries[0].exitedAt?.toISOString());
    expect(secondEntries[0].exitReason).toBe(firstEntries[0].exitReason);
  });
});

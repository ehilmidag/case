import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../database/database-options';
import { MetricsService } from '../metrics/metrics.service';
import { RedisConnection } from '../redis/redis.module';
import { AreaIndexManager } from './area-index.manager';

describe('AreaIndexManager (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let dataSource: DataSource;
  let redisConnection: RedisConnection;
  let manager: AreaIndexManager;

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

    dataSource = new DataSource(
      createDatabaseOptions({
        DATABASE_URL: postgres.getConnectionUri(),
        DATABASE_READ_URL: '',
      }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    const configService = new ConfigService();
    configService.set('REDIS_URL', redis.getConnectionUrl());
    configService.set('GEOFENCE_INDEX', 'rtree');
    configService.set('H3_INDEX_RESOLUTION', 9);
    configService.set('AREA_INDEX_REFRESH_MS', 60_000);
    redisConnection = new RedisConnection(configService);
    manager = new AreaIndexManager(
      dataSource,
      redisConnection,
      new MetricsService(),
      configService,
    );

    await insertArea('first', 29, 41, 29.01, 41.01);
    await manager.onModuleInit();
  }, 180000);

  afterAll(async () => {
    await manager?.onModuleDestroy();
    await redisConnection?.onModuleDestroy();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it('loads the initial primary DB version and containing areas', () => {
    expect(manager.current.version).toBe(1);
    expect(manager.current.findContaining(41.005, 29.005)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it('atomically swaps the index when areas.changed is published', async () => {
    const previous = manager.current;
    await insertArea('second', 30, 42, 30.01, 42.01);
    await redisConnection.client.publish('areas.changed', '2');

    await waitFor(() => manager.current.version === 2);

    expect(manager.current).not.toBe(previous);
    expect(manager.current.findContaining(42.005, 30.005)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(manager.current.findContaining(41.005, 29.005)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it('still picks up an area whose transaction committed after a higher-versioned one', async () => {
    // nextval() for area_set_version_seq is assigned before commit, so commit order can
    // differ from version order: a transaction holding a lower version can commit after
    // one holding a higher version. Comparing MAX(version) alone to decide whether to
    // rebuild would make this area invisible forever, since every later area also has a
    // higher version and MAX(version) would already read as "unchanged".
    await insertAreaWithVersion('higher-version-first', 60, 10, 60.01, 10.01, 100);
    await redisConnection.client.publish('areas.changed', '100');
    await waitFor(() => manager.current.version === 100);

    await insertAreaWithVersion('lower-version-second', 61, 10, 61.01, 10.01, 99);
    await redisConnection.client.publish('areas.changed', '99');

    await waitFor(() => manager.current.findContaining(10.005, 61.005).length > 0);
  });

  async function insertArea(
    name: string,
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO areas (name, geom, version)
       VALUES (
         $1,
         ST_GeomFromText(
           'POLYGON((' || $2 || ' ' || $3 || ',' || $4 || ' ' || $3 || ',' || $4 || ' ' || $5 || ',' ||
           $2 || ' ' || $5 || ',' || $2 || ' ' || $3 || '))',
           4326
         ),
         nextval('area_set_version_seq')
       )`,
      [name, minLng, minLat, maxLng, maxLat],
    );
  }

  async function insertAreaWithVersion(
    name: string,
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
    version: number,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO areas (name, geom, version)
       VALUES (
         $1,
         ST_GeomFromText(
           'POLYGON((' || $2 || ' ' || $3 || ',' || $4 || ' ' || $3 || ',' || $4 || ' ' || $5 || ',' ||
           $2 || ' ' || $5 || ',' || $2 || ' ' || $3 || '))',
           4326
         ),
         $6
       )`,
      [name, minLng, minLat, maxLng, maxLat, version],
    );
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the area index to refresh.');
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
});

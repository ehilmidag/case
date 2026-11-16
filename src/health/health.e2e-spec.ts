import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import request from 'supertest';

const PLANNED_METRIC_NAMES = [
  'locations_ingested_total',
  'locations_rejected_total',
  'stream_pending_messages',
  'worker_batch_duration_seconds',
  'worker_points_processed_total',
  'area_entries_created_total',
  'area_exits_total',
  'dlq_messages_total',
  'geofence_index_version',
  'partition_leases_held',
];

describe('readiness and metrics (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let apiApp: INestApplication;
  let workerApp: INestApplication;

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
    process.env.AREA_INDEX_REFRESH_MS = '60000';
    process.env.PARTITION_LEASE_TTL_MS = '2000';
    process.env.PARTITION_LEASE_RENEW_MS = '300';
    process.env.STREAM_PARTITIONS = '1';

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

    const { AppApiModule } = await import('../app-api.module');
    const apiTestingModule = await Test.createTestingModule({
      imports: [AppApiModule],
    }).compile();
    apiApp = apiTestingModule.createNestApplication();
    await apiApp.init();

    const { AppWorkerModule } = await import('../app-worker.module');
    const workerTestingModule = await Test.createTestingModule({
      imports: [AppWorkerModule],
    }).compile();
    workerApp = workerTestingModule.createNestApplication();
    await workerApp.init();
  }, 180000);

  afterAll(async () => {
    await apiApp?.close();
    await workerApp?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it("the API's readiness check reports the database and Redis as up, with no geofence check", async () => {
    const response = await request(apiApp.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body.info).toMatchObject({
      database: { status: 'up' },
      redis: { status: 'up' },
    });
    expect(response.body.info.geofenceIndex).toBeUndefined();
  });

  it("the worker's readiness check additionally reports the geofence index as loaded", async () => {
    const response = await request(workerApp.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body.info).toMatchObject({
      database: { status: 'up' },
      redis: { status: 'up' },
      geofenceIndex: { status: 'up' },
    });
  });

  it('the worker serves every planned metric on /metrics', async () => {
    const response = await request(workerApp.getHttpServer()).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    for (const name of PLANNED_METRIC_NAMES) {
      expect(response.text).toContain(`# HELP ${name} `);
    }
  });
});

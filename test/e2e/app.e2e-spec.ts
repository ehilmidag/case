import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';

describe('API liveness (e2e)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    // DatabaseModule connects to Postgres, and AreasModule's global RedisModule connects
    // to Redis, during module init, so booting the full app needs both reachable even
    // though /health/live itself queries neither. Plain images are enough: this smoke
    // test never runs migrations/queries or exercises the areas cache.
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16').start(),
      new RedisContainer('redis:7').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    const { AppApiModule } = await import('../../src/app-api.module');
    const testingModule: TestingModule = await Test.createTestingModule({
      imports: [AppApiModule],
    }).compile();

    app = testingModule.createNestApplication();
    await app.init();
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
  }, 60000);

  it('returns a healthy response with a request ID', async () => {
    if (!app) {
      throw new Error('The API test application was not initialized.');
    }

    const response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });
});

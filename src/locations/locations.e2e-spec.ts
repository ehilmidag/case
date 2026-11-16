import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { BackpressureMonitor } from './backpressure-monitor.service';
import { locationStreamKey, partitionForUser } from './partitioner';
import { RedisConnection } from '../redis/redis.module';

function location(userId: string, timestamp = new Date().toISOString()) {
  return {
    userId,
    latitude: 41.0405,
    longitude: 29.0213,
    timestamp,
  };
}

describe('locations API (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication | undefined;

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
    process.env.BACKPRESSURE_MAX_PENDING = '2';
    process.env.RATE_LIMIT_PER_MIN = '1000';

    const { AppApiModule } = await import('../app-api.module');
    const testingModule = await Test.createTestingModule({ imports: [AppApiModule] }).compile();
    app = testingModule.createNestApplication();
    await app.init();
    await app.get(DataSource).runMigrations();
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it('accepts a single point and writes the planned Redis stream fields', async () => {
    const point = location('single-user');
    const response = await request(getApp().getHttpServer())
      .post('/locations')
      .send(point)
      .expect(202);

    expect(response.body).toEqual({ accepted: 1, rejected: [] });
    const stream = locationStreamKey(partitionForUser(point.userId, 16));
    const entries = await getApp().get(RedisConnection).client.xrange(stream, '-', '+');
    expect(entries).toHaveLength(1);
    const fields = Object.fromEntries(
      entries[0][1].reduce<Array<[string, string]>>((pairs, value, index, values) => {
        if (index % 2 === 0) {
          pairs.push([value, values[index + 1]]);
        }
        return pairs;
      }, []),
    );
    expect(fields).toMatchObject({
      userId: point.userId,
      lat: String(point.latitude),
      lng: String(point.longitude),
      ts: String(Date.parse(point.timestamp)),
    });
    expect(Number(fields.receivedAt)).toBeGreaterThan(0);
  });

  it('accepts a batch and routes each point to the stable user partition', async () => {
    await getApp().get(RedisConnection).client.flushdb();
    const points = [location('batch-a'), location('batch-a'), location('batch-b')];
    const response = await request(getApp().getHttpServer())
      .post('/locations')
      .send({ locations: points })
      .expect(202);

    expect(response.body).toEqual({ accepted: 3, rejected: [] });
    const stream = locationStreamKey(partitionForUser('batch-a', 16));
    const entries = await getApp().get(RedisConnection).client.xrange(stream, '-', '+');
    const users = entries.map(([, fields]) => {
      const fieldIndex = fields.indexOf('userId');
      return fields[fieldIndex + 1];
    });
    expect(users.filter((userId) => userId === 'batch-a')).toHaveLength(2);

    const monitor = getApp().get(BackpressureMonitor);
    await monitor.refresh();
    expect(monitor.pending).toBe(3);
  });

  it('accepts the valid point in a mixed batch and reports only the invalid one (partial accept)', async () => {
    await getApp().get(RedisConnection).client.flushdb();
    // The previous test leaves BackpressureMonitor's cached pending count at 3 (right at
    // BACKPRESSURE_MAX_PENDING=2); flushdb alone doesn't reset that cache, only its own
    // periodic refresh does — force one now so this test isn't spuriously backpressured.
    await getApp().get(BackpressureMonitor).refresh();
    const mixedBatch = await request(getApp().getHttpServer())
      .post('/locations')
      .send({
        locations: [
          location('partial-accept-valid'),
          location('partial-accept-invalid', new Date(Date.now() - 3_000_000_000).toISOString()),
        ],
      })
      .expect(202);

    expect(mixedBatch.body.accepted).toBe(1);
    expect(mixedBatch.body.rejected).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 1, field: 'timestamp' })]),
    );

    // The valid point must have actually reached Redis — not just be reflected in the
    // response body — proving the invalid sibling didn't drop it from the batch.
    const stream = locationStreamKey(partitionForUser('partial-accept-valid', 16));
    const entries = await getApp().get(RedisConnection).client.xrange(stream, '-', '+');
    expect(entries).toHaveLength(1);
  });

  it('rejects a batch with no valid points, and a single invalid point, with 400', async () => {
    const allInvalidBatch = await request(getApp().getHttpServer())
      .post('/locations')
      .send({
        locations: [
          location('all-invalid-a', new Date(Date.now() - 3_000_000_000).toISOString()),
          location('all-invalid-b', new Date(Date.now() - 3_000_000_000).toISOString()),
        ],
      })
      .expect(400);
    expect(allInvalidBatch.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 0, field: 'timestamp' }),
        expect.objectContaining({ index: 1, field: 'timestamp' }),
      ]),
    );

    const coordinatePayload = { ...location('bad-coordinate'), latitude: 91 };
    await request(getApp().getHttpServer()).post('/locations').send(coordinatePayload).expect(400);
  });

  it('returns 503 with Retry-After when sampled consumer lag reaches the threshold', async () => {
    const redisConnection = getApp().get(RedisConnection);
    const stream = locationStreamKey(0);
    await redisConnection.client.flushdb();
    await redisConnection.client.xadd(stream, '*', 'userId', 'queued-a');
    await redisConnection.client.xadd(stream, '*', 'userId', 'queued-b');
    await redisConnection.client.xgroup('CREATE', stream, 'geofence', '0', 'MKSTREAM');

    const monitor = getApp().get(BackpressureMonitor);
    await monitor.refresh();
    expect(monitor.pending).toBe(2);

    const response = await request(getApp().getHttpServer())
      .post('/locations')
      .send(location('backpressured-user'))
      .expect(503);
    expect(response.headers['retry-after']).toBe('1');
  });

  function getApp(): INestApplication {
    if (!app) {
      throw new Error('The locations test application was not initialized.');
    }

    return app;
  }
});

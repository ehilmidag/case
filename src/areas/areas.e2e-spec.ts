import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import request from 'supertest';

type Polygon = {
  type: 'Polygon';
  coordinates: [number, number][][];
};

function square(minLng: number, minLat: number, maxLng: number, maxLat: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}

describe('areas API (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;

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

    const { AppApiModule } = await import('../app-api.module');
    const { Test } = await import('@nestjs/testing');
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

  it('creates a GeoJSON Feature and sets its Location header', async () => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: '  Central Park  ', geometry: square(29, 41, 29.01, 41.01) })
      .expect(201);

    expect(response.headers.location).toBe(`/areas/${response.body.id}`);
    expect(response.body.type).toBe('Feature');
    expect(response.body.geometry.type).toBe('Polygon');
    expect(response.body.properties.name).toBe('Central Park');
    expect(response.body.properties.version).toBe(1);
  });

  it('rejects open rings and out-of-range coordinates with 400', async () => {
    const openRing = square(29, 41, 29.01, 41.01);
    openRing.coordinates[0].pop();

    await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Open ring', geometry: openRing })
      .expect(400);

    await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Out of range', geometry: square(181, 41, 182, 42) })
      .expect(400);
  });

  it('enforces MAX_POLYGON_VERTICES', async () => {
    const ring = Array.from({ length: 10_001 }, () => [0, 0] as [number, number]);

    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Too many vertices', geometry: { type: 'Polygon', coordinates: [ring] } })
      .expect(400);

    expect(response.body.message).toContain('MAX_POLYGON_VERTICES');
  });

  it('returns the PostGIS validity reason for a self-intersecting polygon', async () => {
    const geometry: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    };

    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Invalid shape', geometry })
      .expect(422);

    expect(response.body.message).toBe('Invalid polygon');
    expect(response.body.reason).toContain('Self-intersection');
  });

  it('accepts polygons with holes', async () => {
    const geometry: Polygon = {
      type: 'Polygon',
      coordinates: [
        square(40, 40, 41, 41).coordinates[0],
        square(40.2, 40.2, 40.8, 40.8).coordinates[0].reverse(),
      ],
    };

    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Area with a hole', geometry })
      .expect(201);

    expect(response.body.geometry.coordinates).toHaveLength(2);
  });

  it('supports bbox filtering, keyset pagination, ETag 304, and version cache invalidation', async () => {
    await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Page one', geometry: square(50, 20, 50.2, 20.2) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Page two', geometry: square(50.3, 20, 50.5, 20.2) })
      .expect(201);

    const bbox = '49,19,51,21';
    const firstPage = await request(app.getHttpServer())
      .get('/areas')
      .query({ bbox, limit: 1 })
      .expect(200);
    expect(firstPage.body.features).toHaveLength(1);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app.getHttpServer())
      .get('/areas')
      .query({ bbox, limit: 1, cursor: firstPage.body.nextCursor })
      .expect(200);
    expect(secondPage.body.features).toHaveLength(1);
    expect(secondPage.body.features[0].id).not.toBe(firstPage.body.features[0].id);
    expect(secondPage.body.nextCursor).toBeNull();

    const cachedPage = await request(app.getHttpServer())
      .get('/areas')
      .query({ bbox, limit: 1 })
      .expect(200);
    const etag = cachedPage.headers.etag as string;

    await request(app.getHttpServer())
      .get('/areas')
      .query({ bbox, limit: 1 })
      .set('If-None-Match', etag)
      .expect(304);

    await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'Invalidates prior version', geometry: square(50.6, 20, 50.8, 20.2) })
      .expect(201);

    const refreshedPage = await request(app.getHttpServer())
      .get('/areas')
      .query({ bbox, limit: 1 })
      .set('If-None-Match', etag)
      .expect(200);
    expect(refreshedPage.headers.etag).not.toBe(etag);
    expect(refreshedPage.body.features).toHaveLength(1);
  });

  it('validates bbox and cursor values', async () => {
    await request(app.getHttpServer()).get('/areas').query({ bbox: '1,2,3' }).expect(400);
    await request(app.getHttpServer()).get('/areas').query({ cursor: 'not-a-cursor' }).expect(400);
  });
});

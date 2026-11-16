import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { RedisConnection } from '../redis/redis.module';
import { locationStreamKey, partitionForUser } from '../locations/partitioner';
import { DLQ_STREAM_KEY } from './dlq';

describe('DLQ end-to-end (e2e)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let redisConnection: RedisConnection;

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
    process.env.WORKER_BLOCK_MS = '100';
    process.env.MAX_DELIVERY_ATTEMPTS = '2';
    process.env.PARTITION_LEASE_TTL_MS = '2000';
    process.env.PARTITION_LEASE_RENEW_MS = '300';
    process.env.AREA_INDEX_REFRESH_MS = '5000';
    process.env.SIGNAL_TIMEOUT_MS = '600000';
    process.env.STATE_REFRESH_MS = '100000';
    process.env.FORCE_EVAL_MS = '50000';
    process.env.SWEEPER_INTERVAL_MS = '600000';

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
    await app.init();

    redisConnection = app.get(RedisConnection);
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60000);

  it('moves a message that keeps failing to the DLQ once delivery attempts are exhausted', async () => {
    const userId = 'dlq-poison-user';
    const partition = partitionForUser(userId, 1);
    const stream = locationStreamKey(partition);

    // Missing 'lat' makes parseStreamFields throw every single time — a true poison
    // message, not a transient failure a retry would resolve.
    await redisConnection.client.xadd(
      stream,
      '*',
      'userId',
      userId,
      'lng',
      '29.005',
      'ts',
      String(Date.now()),
    );

    const dlqEntry = await waitForCondition(async () => {
      const entries = await redisConnection.client.xrange(DLQ_STREAM_KEY, '-', '+');
      return entries.find((entry) => fieldValue(entry[1], 'sourceStream') === stream) ?? null;
    }, 'expected the poison message to reach the DLQ');

    expect(fieldValue(dlqEntry[1], 'userId')).toBe(userId);
    expect(fieldValue(dlqEntry[1], 'error')).toContain('Malformed location message');

    const pendingSummary = (await redisConnection.client.xpending(stream, 'geofence')) as [
      number,
      string | null,
      string | null,
      unknown,
    ];
    expect(pendingSummary[0]).toBe(0);
  }, 20000);

  function fieldValue(fields: string[], name: string): string | undefined {
    const index = fields.indexOf(name);
    return index < 0 ? undefined : fields[index + 1];
  }

  async function waitForCondition<T>(
    check: () => Promise<T | null>,
    message: string,
    timeoutMs = 15000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result !== null) {
        return result;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting: ${message}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
});

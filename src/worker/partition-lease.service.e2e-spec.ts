import { ConfigService } from '@nestjs/config';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { MetricsService } from '../metrics/metrics.service';
import { RedisConnection } from '../redis/redis.module';
import { PartitionLeaseService } from './partition-lease.service';

function makeService(redisUrl: string): {
  service: PartitionLeaseService;
  connection: RedisConnection;
} {
  const configService = new ConfigService({
    REDIS_URL: redisUrl,
    STREAM_PARTITIONS: 4,
    PARTITION_LEASE_TTL_MS: 1000,
    PARTITION_LEASE_RENEW_MS: 150,
  });
  const connection = new RedisConnection(configService);
  return {
    service: new PartitionLeaseService(connection, new MetricsService(), configService),
    connection,
  };
}

async function teardown(instance: {
  service: PartitionLeaseService;
  connection: RedisConnection;
}): Promise<void> {
  await instance.service.onModuleDestroy();
  await instance.connection.onModuleDestroy();
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for partition lease state.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

describe('PartitionLeaseService (e2e)', () => {
  let container: StartedRedisContainer;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7').start();
  }, 60000);

  afterAll(async () => {
    await container?.stop();
  }, 30000);

  it('a single worker acquires every partition', async () => {
    const instance = makeService(container.getConnectionUrl());
    try {
      await instance.service.onModuleInit();
      expect(instance.service.ownedPartitions.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    } finally {
      await teardown(instance);
    }
  });

  it('two workers split the partitions evenly between them', async () => {
    const first = makeService(container.getConnectionUrl());
    const second = makeService(container.getConnectionUrl());
    try {
      await first.service.onModuleInit();
      await second.service.onModuleInit();

      await waitUntil(
        () =>
          first.service.ownedPartitions.length === 2 && second.service.ownedPartitions.length === 2,
      );

      const combined = [...first.service.ownedPartitions, ...second.service.ownedPartitions].sort(
        (a, b) => a - b,
      );
      expect(combined).toEqual([0, 1, 2, 3]);
    } finally {
      await teardown(first);
      await teardown(second);
    }
  }, 15000);

  it("redistributes a departing worker's partitions to the one still running", async () => {
    const first = makeService(container.getConnectionUrl());
    const second = makeService(container.getConnectionUrl());
    try {
      await first.service.onModuleInit();
      await second.service.onModuleInit();
      await waitUntil(
        () =>
          first.service.ownedPartitions.length === 2 && second.service.ownedPartitions.length === 2,
      );

      await teardown(second);

      await waitUntil(() => first.service.ownedPartitions.length === 4);
      expect(first.service.ownedPartitions.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    } finally {
      await teardown(first);
    }
  }, 15000);

  it('acquires partitions once a stale lease (from a worker that stopped renewing) expires', async () => {
    const seedConfig = new ConfigService({ REDIS_URL: container.getConnectionUrl() });
    const seedConnection = new RedisConnection(seedConfig);
    await new Promise<void>((resolve, reject) => {
      if (seedConnection.client.status === 'ready') {
        resolve();
        return;
      }
      seedConnection.client.once('ready', resolve);
      seedConnection.client.once('error', reject);
    });

    const staleTtlMs = 300;
    for (let partition = 0; partition < 4; partition += 1) {
      await seedConnection.client.set(
        `lease:partition:${partition}`,
        'stale-worker',
        'PX',
        staleTtlMs,
      );
    }

    const fresh = makeService(container.getConnectionUrl());
    try {
      await fresh.service.onModuleInit();
      expect(fresh.service.ownedPartitions.length).toBe(0);

      await waitUntil(() => fresh.service.ownedPartitions.length === 4, 8000);
      expect(fresh.service.ownedPartitions.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    } finally {
      await teardown(fresh);
      await seedConnection.onModuleDestroy();
    }
  }, 15000);
});

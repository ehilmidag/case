import { ConfigService } from '@nestjs/config';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { RedisConnection } from '../redis/redis.module';
import { RedisFilter, userFilterKey } from './redis-filter';

describe('RedisFilter (e2e)', () => {
  let container: StartedRedisContainer;
  let connection: RedisConnection;
  let filter: RedisFilter;
  let client: Redis;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7').start();
    const configService = new ConfigService({
      REDIS_URL: container.getConnectionUrl(),
      USER_FILTER_TTL_S: 3600,
    });
    connection = new RedisConnection(configService);
    filter = new RedisFilter(connection, configService);
    client = connection.client;
    if (client.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
      });
    }
    await client.ping();
  }, 60000);

  afterAll(async () => {
    await connection?.onModuleDestroy();
    await container?.stop();
  }, 30000);

  beforeEach(async () => {
    await client.flushdb();
  });

  it('uses a stable Redis Cluster hash tag in user keys', () => {
    expect(userFilterKey('user-123')).toBe('{u:user-123}:f');
    expect(userFilterKey('user:{123}')).toBe('{u:user%3A%7B123%7D}:f');
  });

  it('pipelines HGETALL reads and parses missing and present filter state', async () => {
    await filter.update({ userId: 'user-a', ts: 100, cell: 'cell-a', evalTs: 90, stable: true });
    const states = await filter.readMany(['user-a', 'missing', 'user-a']);

    expect([...states.keys()]).toEqual(['user-a', 'missing']);
    expect(states.get('user-a')).toEqual({ ts: 100, cell: 'cell-a', evalTs: 90, stable: true });
    expect(states.get('missing')).toBeNull();
  });

  it('applies monotonic Lua updates, preserves omitted fields, and refreshes TTL', async () => {
    await expect(
      filter.update({ userId: 'user-a', ts: 100, cell: 'cell-a', evalTs: 95, stable: true }),
    ).resolves.toBe(true);
    await expect(filter.update({ userId: 'user-a', ts: 100, cell: 'same-ts' })).resolves.toBe(
      false,
    );
    await expect(filter.update({ userId: 'user-a', ts: 99, cell: 'stale' })).resolves.toBe(false);
    await expect(filter.update({ userId: 'user-a', ts: 110, cell: 'cell-b' })).resolves.toBe(true);

    expect(await filter.readMany(['user-a'])).toEqual(
      new Map([['user-a', { ts: 110, cell: 'cell-b', evalTs: 95, stable: true }]]),
    );
    expect(await client.ttl(userFilterKey('user-a'))).toBeGreaterThan(0);
  });

  it('supports batched script execution and per-user monotonic results', async () => {
    await expect(
      filter.updateMany([
        { userId: 'user-a', ts: 200, cell: 'cell-a' },
        { userId: 'user-a', ts: 199, cell: 'stale' },
        { userId: 'user-b', ts: 150, cell: 'cell-b', stable: false },
      ]),
    ).resolves.toEqual([true, false, true]);

    const states = await filter.readMany(['user-a', 'user-b']);
    expect(states.get('user-a')).toMatchObject({ ts: 200, cell: 'cell-a' });
    expect(states.get('user-b')).toMatchObject({ ts: 150, cell: 'cell-b', stable: false });
  });
});

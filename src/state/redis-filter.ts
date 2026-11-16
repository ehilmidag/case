import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisConnection } from '../redis/redis.module';

export type RedisFilterState = {
  ts: number;
  cell: string;
  evalTs: number | null;
  stable: boolean;
};

export type RedisFilterUpdate = {
  userId: string;
  ts: number;
  cell: string;
  evalTs?: number;
  stable?: boolean;
};

export const UPDATE_FILTER_SCRIPT = `
local cur = tonumber(redis.call('HGET', KEYS[1], 'ts') or '0')
if tonumber(ARGV[1]) <= cur then return 0 end
redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'cell', ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'evalTs', ARGV[3]) end
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'stable', ARGV[4]) end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
`;

export function userFilterKey(userId: string): string {
  return `{u:${encodeURIComponent(userId)}}:f`;
}

@Injectable()
export class RedisFilter {
  private readonly client: Redis;
  private readonly ttlSeconds: number;

  constructor(redis: RedisConnection, configService: ConfigService) {
    this.client = redis.client;
    this.ttlSeconds = configService.getOrThrow<number>('USER_FILTER_TTL_S');
  }

  async readMany(userIds: string[]): Promise<Map<string, RedisFilterState | null>> {
    const uniqueUserIds = [...new Set(userIds)];
    const states = new Map<string, RedisFilterState | null>(
      uniqueUserIds.map((userId) => [userId, null]),
    );
    if (uniqueUserIds.length === 0) {
      return states;
    }

    const pipeline = this.client.pipeline();
    for (const userId of uniqueUserIds) {
      pipeline.hgetall(userFilterKey(userId));
    }

    const results = await pipeline.exec();
    if (!results) {
      throw new Error('Redis filter pipeline did not return results.');
    }

    results.forEach(([error, hash], index) => {
      if (error) {
        throw error;
      }

      const values = hash as Record<string, string>;
      if (!values.ts || !values.cell) {
        return;
      }

      const ts = Number(values.ts);
      const evalTs = values.evalTs === undefined ? null : Number(values.evalTs);
      if (!Number.isFinite(ts) || (evalTs !== null && !Number.isFinite(evalTs))) {
        return;
      }

      states.set(uniqueUserIds[index], {
        ts,
        cell: values.cell,
        evalTs,
        stable: values.stable === '1',
      });
    });

    return states;
  }

  async update(update: RedisFilterUpdate): Promise<boolean> {
    const result = await this.client.eval(
      UPDATE_FILTER_SCRIPT,
      1,
      userFilterKey(update.userId),
      String(update.ts),
      update.cell,
      update.evalTs === undefined ? '' : String(update.evalTs),
      update.stable === undefined ? '' : update.stable ? '1' : '0',
      String(this.ttlSeconds),
    );

    return result === 1;
  }

  async updateMany(updates: RedisFilterUpdate[]): Promise<boolean[]> {
    if (updates.length === 0) {
      return [];
    }

    const pipeline = this.client.pipeline();
    for (const update of updates) {
      pipeline.eval(
        UPDATE_FILTER_SCRIPT,
        1,
        userFilterKey(update.userId),
        String(update.ts),
        update.cell,
        update.evalTs === undefined ? '' : String(update.evalTs),
        update.stable === undefined ? '' : update.stable ? '1' : '0',
        String(this.ttlSeconds),
      );
    }

    const results = await pipeline.exec();
    if (!results) {
      throw new Error('Redis filter update pipeline did not return results.');
    }

    return results.map(([error, result]) => {
      if (error) {
        throw error;
      }

      return result === 1;
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { latLngToCell } from 'h3-js';
import { AreaIndexManager } from '../geofence/area-index.manager';
import { MetricsService } from '../metrics/metrics.service';
import { RedisConnection } from '../redis/redis.module';
import { RedisFilter, RedisFilterUpdate } from '../state/redis-filter';
import { transition, TransitionConfig } from '../state/transition';
import { UserStateRepository } from '../state/user-state.repository';
import { aggregateBatchChanges, applyTransitionToState } from './batch-state';
import { buildDlqFields, DLQ_STREAM_KEY, StreamMessage } from './dlq';
import { FaultInjector } from './fault-injector';
import { shouldSkipEvaluation } from './skip-rule';

type ParsedPoint = {
  id: string;
  userId: string;
  lat: number;
  lng: number;
  ts: number;
};

@Injectable()
export class BatchProcessorService {
  private readonly logger = new Logger(BatchProcessorService.name);
  private readonly transitionConfig: TransitionConfig;
  private readonly h3SkipResolution: number;
  private readonly forceEvalMs: number;
  private readonly maxDeliveryAttempts: number;

  constructor(
    private readonly areaIndexManager: AreaIndexManager,
    private readonly redisFilter: RedisFilter,
    private readonly userStateRepository: UserStateRepository,
    private readonly redis: RedisConnection,
    private readonly metrics: MetricsService,
    private readonly faultInjector: FaultInjector,
    configService: ConfigService,
  ) {
    this.transitionConfig = {
      exitConfirmPoints: configService.getOrThrow<number>('EXIT_CONFIRM_POINTS'),
      exitConfirmMs: configService.getOrThrow<number>('EXIT_CONFIRM_MS'),
      stateRefreshMs: configService.getOrThrow<number>('STATE_REFRESH_MS'),
    };
    this.h3SkipResolution = configService.getOrThrow<number>('H3_SKIP_RESOLUTION');
    this.forceEvalMs = configService.getOrThrow<number>('FORCE_EVAL_MS');
    this.maxDeliveryAttempts = configService.getOrThrow<number>('MAX_DELIVERY_ATTEMPTS');
  }

  async process(stream: string, group: string, messages: StreamMessage[]): Promise<void> {
    await this.processWithBisect(stream, group, messages);
  }

  private async processWithBisect(
    stream: string,
    group: string,
    messages: StreamMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const endTimer = this.metrics.workerBatchDurationSeconds.startTimer();
    try {
      await this.processBatch(messages);
      endTimer();
      await this.redis.client.xack(stream, group, ...messages.map(([id]) => id));
    } catch (error) {
      endTimer();
      if (messages.length === 1) {
        await this.handleSingleMessageFailure(stream, group, messages[0], error);
        return;
      }

      this.logger.warn(
        `Batch of ${messages.length} on ${stream} failed, bisecting: ${String(error)}`,
      );
      const mid = Math.floor(messages.length / 2);
      await this.processWithBisect(stream, group, messages.slice(0, mid));
      await this.processWithBisect(stream, group, messages.slice(mid));
    }
  }

  private async handleSingleMessageFailure(
    stream: string,
    group: string,
    message: StreamMessage,
    error: unknown,
  ): Promise<void> {
    const [id, fields] = message;
    const pending = (await this.redis.client.xpending(stream, group, id, id, 1)) as Array<
      [string, string, number, number]
    >;
    const deliveryCount = pending[0]?.[3] ?? 1;
    this.logger.error(
      `Message ${id} on ${stream} failed (delivery ${deliveryCount}/${this.maxDeliveryAttempts}): ${String(error)}`,
    );

    if (deliveryCount >= this.maxDeliveryAttempts) {
      await this.redis.client.xadd(
        DLQ_STREAM_KEY,
        '*',
        ...buildDlqFields(stream, id, error, fields),
      );
      await this.redis.client.xack(stream, group, id);
      this.metrics.dlqMessagesTotal.inc();
      this.logger.error(`Message ${id} moved to ${DLQ_STREAM_KEY} after exhausting retries.`);
    }
    // Otherwise leave it unacked: it stays pending and is redelivered by the next
    // XREADGROUP/XAUTOCLAIM cycle, incrementing its delivery count each time.
  }

  private async processBatch(messages: StreamMessage[]): Promise<void> {
    const points = messages.map(([id, fields]) => ({ id, ...parseStreamFields(id, fields) }));
    const byUser = groupByUserSorted(points);
    const filterStates = await this.redisFilter.readMany([...byUser.keys()]);
    const index = this.areaIndexManager.current;
    const indexVersion = index.version;

    const filterUpdates: RedisFilterUpdate[] = [];
    const faultMessageId = messages[0][0];

    this.faultInjector.trigger('before-transaction', faultMessageId);

    await this.userStateRepository.transaction(async (manager) => {
      const usersToLoad = [...byUser.keys()];
      const statesByUser = await this.userStateRepository.lockAndLoad(manager, usersToLoad);

      this.faultInjector.trigger('during-transaction', faultMessageId);

      for (const [userId, userPoints] of byUser) {
        let state = statesByUser.get(userId) ?? [];
        let filter = filterStates.get(userId) ?? null;
        const results: ReturnType<typeof transition>[] = [];

        for (const point of userPoints) {
          if (filter && point.ts <= filter.ts) {
            this.metrics.workerPointsProcessedTotal.inc({ result: 'stale' });
            continue;
          }

          const cell = latLngToCell(point.lat, point.lng, this.h3SkipResolution);
          const currentFilter = filter;
          if (
            shouldSkipEvaluation(
              currentFilter,
              point,
              cell,
              index.isUniformCell(cell),
              this.forceEvalMs,
            )
          ) {
            filterUpdates.push({ userId, ts: point.ts, cell });
            filter = { ...currentFilter, ts: point.ts, cell };
            this.metrics.workerPointsProcessedTotal.inc({ result: 'skipped' });
            continue;
          }

          this.metrics.workerPointsProcessedTotal.inc({ result: 'evaluated' });
          const matchedAreaIds = index.findContaining(point.lat, point.lng);
          const result = transition(
            state,
            { ts: new Date(point.ts) },
            matchedAreaIds,
            this.transitionConfig,
          );
          results.push(result);
          state = applyTransitionToState(state, result);
          const stable = state.every((row) => row.outsideCount === 0);
          filterUpdates.push({ userId, ts: point.ts, cell, evalTs: point.ts, stable });
          filter = { ts: point.ts, cell, evalTs: point.ts, stable };
        }

        if (results.length > 0) {
          const aggregated = aggregateBatchChanges(results);
          if (
            aggregated.entries.length > 0 ||
            aggregated.exits.length > 0 ||
            aggregated.upserts.length > 0 ||
            aggregated.deletes.length > 0
          ) {
            await this.userStateRepository.applyChanges(manager, userId, {
              ...aggregated,
              areaSetVersion: indexVersion,
            });
            if (aggregated.entries.length > 0) {
              this.metrics.areaEntriesCreatedTotal.inc(aggregated.entries.length);
            }
            if (aggregated.exits.length > 0) {
              this.metrics.areaExitsTotal.inc({ reason: 'left' }, aggregated.exits.length);
            }
          }
        }
      }
    });

    this.faultInjector.trigger('after-commit', faultMessageId);

    if (filterUpdates.length > 0) {
      await this.redisFilter.updateMany(filterUpdates);
    }

    this.faultInjector.trigger('after-redis-update', faultMessageId);
  }
}

function parseStreamFields(id: string, fields: string[]): Omit<ParsedPoint, 'id'> {
  const map = new Map<string, string>();
  for (let index = 0; index < fields.length - 1; index += 2) {
    map.set(fields[index], fields[index + 1]);
  }

  const userId = map.get('userId');
  const lat = Number(map.get('lat'));
  const lng = Number(map.get('lng'));
  const ts = Number(map.get('ts'));

  if (!userId || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(ts)) {
    throw new Error(`Malformed location message ${id} on stream.`);
  }

  return { userId, lat, lng, ts };
}

function groupByUserSorted(points: ParsedPoint[]): Map<string, ParsedPoint[]> {
  const byUser = new Map<string, ParsedPoint[]>();
  for (const point of points) {
    const list = byUser.get(point.userId) ?? [];
    list.push(point);
    byUser.set(point.userId, list);
  }

  for (const list of byUser.values()) {
    list.sort((a, b) => a.ts - b.ts);
  }

  return byUser;
}

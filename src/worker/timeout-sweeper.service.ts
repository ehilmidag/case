import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';

// Arbitrary fixed id for the advisory lock that serializes the sweep across every worker
// instance — only one instance should run a sweep pass at a time. pg_try_advisory_xact_lock
// is transaction-scoped, so it releases automatically at COMMIT/ROLLBACK regardless of
// connection pooling; a session-scoped lock would risk leaking if the pooled connection
// were ever returned without an explicit unlock.
const SWEEPER_ADVISORY_LOCK_ID = 72700100;

type TimedOutRow = {
  user_id: string;
  area_id: string;
  entered_at: Date;
  last_inside_at: Date;
};

@Injectable()
export class TimeoutSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeoutSweeperService.name);
  private readonly signalTimeoutMs: number;
  private readonly batchSize: number;
  private readonly sweeperIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    configService: ConfigService,
  ) {
    this.signalTimeoutMs = configService.getOrThrow<number>('SIGNAL_TIMEOUT_MS');
    this.batchSize = configService.getOrThrow<number>('WORKER_BATCH_SIZE');
    this.sweeperIntervalMs = configService.getOrThrow<number>('SWEEPER_INTERVAL_MS');
  }

  async onModuleInit(): Promise<void> {
    await this.sweep().catch((error: unknown) => {
      this.logger.error(`Initial timeout sweep failed: ${String(error)}`);
    });

    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error(`Timeout sweep failed: ${String(error)}`);
      });
    }, this.sweeperIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async sweep(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const [{ locked }] = (await manager.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [
        SWEEPER_ADVISORY_LOCK_ID,
      ])) as Array<{ locked: boolean }>;
      if (!locked) {
        return 0;
      }

      const threshold = new Date(Date.now() - this.signalTimeoutMs);
      const rows = (await manager.query(
        `SELECT user_id, area_id, entered_at, last_inside_at
         FROM user_area_state
         WHERE last_inside_at < $1
         ORDER BY last_inside_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [threshold, this.batchSize],
      )) as TimedOutRow[];

      for (const row of rows) {
        await manager.query(
          `UPDATE area_entries
           SET exited_at = $3, exit_reason = 'timeout'
           WHERE user_id = $1 AND area_id = $2::uuid AND entered_at = $4`,
          [row.user_id, row.area_id, row.last_inside_at, row.entered_at],
        );
        await manager.query(
          'DELETE FROM user_area_state WHERE user_id = $1 AND area_id = $2::uuid',
          [row.user_id, row.area_id],
        );
      }

      if (rows.length > 0) {
        this.metrics.areaExitsTotal.inc({ reason: 'timeout' }, rows.length);
        this.logger.log(`Timed out ${rows.length} user/area state row(s) for signal loss.`);
      }

      return rows.length;
    });
  }
}

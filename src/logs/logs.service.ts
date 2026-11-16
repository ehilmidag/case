import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AreaEntry } from '../database/entities/area-entry.entity';
import { ListLogsQueryDto } from './dto/list-logs-query.dto';

export type LogItem = {
  id: string;
  userId: string;
  areaId: string;
  entryTime: string;
  exitTime: string | null;
  exitReason: string | null;
};

export type LogPage = {
  items: LogItem[];
  nextCursor: string | null;
};

type LogRow = {
  id: string;
  userId: string;
  areaId: string;
  enteredAt: Date;
  exitedAt: Date | null;
  exitReason: string | null;
  cursorEnteredAt?: string;
};

type Cursor = {
  enteredAt: string;
  id: string;
};

// If the caller gives neither bound, defaulting to the last 30 days keeps the query
// confined to a handful of recent monthly partitions instead of scanning all of them.
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class LogsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(query: ListLogsQueryDto): Promise<LogPage> {
    const cursor = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor);
    const from =
      query.from === undefined && query.to === undefined
        ? new Date(Date.now() - DEFAULT_WINDOW_MS)
        : query.from === undefined
          ? undefined
          : new Date(query.from);
    const to = query.to === undefined ? undefined : new Date(query.to);

    // Reads go against the replica: GET /logs is read-heavy and tolerates the eventual
    // consistency plan.md already documents for it, so it shouldn't compete with the
    // worker's writes on the primary.
    const queryRunner = this.dataSource.createQueryRunner('slave');
    try {
      const builder = queryRunner.manager
        .getRepository(AreaEntry)
        .createQueryBuilder('entry')
        .select('entry.id', 'id')
        .addSelect('entry.userId', 'userId')
        .addSelect('entry.areaId', 'areaId')
        .addSelect('entry.enteredAt', 'enteredAt')
        .addSelect(
          `to_char(entry.enteredAt AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          'cursorEnteredAt',
        )
        .addSelect('entry.exitedAt', 'exitedAt')
        .addSelect('entry.exitReason', 'exitReason')
        .orderBy('entry.enteredAt', 'DESC')
        .addOrderBy('entry.id', 'DESC')
        .take(query.limit + 1);

      if (query.userId !== undefined) {
        builder.andWhere('entry.userId = :userId', { userId: query.userId });
      }
      if (query.areaId !== undefined) {
        builder.andWhere('entry.areaId = :areaId', { areaId: query.areaId });
      }
      if (from !== undefined) {
        builder.andWhere('entry.enteredAt >= :from', { from });
      }
      if (to !== undefined) {
        builder.andWhere('entry.enteredAt < :to', { to });
      }
      if (cursor) {
        builder.andWhere('(entry.enteredAt, entry.id) < (:cursorEnteredAt, :cursorId)', {
          cursorEnteredAt: cursor.enteredAt,
          cursorId: cursor.id,
        });
      }

      const rows = (await builder.getRawMany()) as LogRow[];
      const hasMore = rows.length > query.limit;
      const visibleRows = rows.slice(0, query.limit);
      const items = visibleRows.map((row) => this.toItem(row));
      const lastRow = visibleRows.at(-1);

      return {
        items,
        nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow) : null,
      };
    } finally {
      await queryRunner.release();
    }
  }

  private toItem(row: LogRow): LogItem {
    return {
      id: row.id,
      userId: row.userId,
      areaId: row.areaId,
      entryTime: new Date(row.enteredAt).toISOString(),
      exitTime: row.exitedAt ? new Date(row.exitedAt).toISOString() : null,
      exitReason: row.exitReason,
    };
  }

  private decodeCursor(value: string): Cursor {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (typeof decoded !== 'object' || decoded === null) {
        throw new Error('Invalid cursor payload');
      }

      const cursor = decoded as Record<string, unknown>;
      if (
        typeof cursor.enteredAt !== 'string' ||
        Number.isNaN(Date.parse(cursor.enteredAt)) ||
        typeof cursor.id !== 'string'
      ) {
        throw new Error('Invalid cursor payload');
      }

      return { enteredAt: cursor.enteredAt, id: cursor.id };
    } catch {
      throw new BadRequestException('cursor must be a valid opaque logs cursor');
    }
  }

  private encodeCursor(row: LogRow): string {
    const cursor: Cursor = {
      enteredAt: row.cursorEnteredAt ?? new Date(row.enteredAt).toISOString(),
      id: row.id,
    };
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }
}

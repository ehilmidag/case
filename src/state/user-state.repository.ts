import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AreaEntry } from '../database/entities/area-entry.entity';
import { UserAreaState } from '../database/entities/user-area-state.entity';
import { StateRow, StateTransition } from './transition';

type StateDatabaseRow = {
  user_id: string;
  area_id: string;
  entered_at: Date;
  last_inside_at: Date;
  outside_count: number;
  first_outside_at: Date | null;
};

export type UserStateChanges = StateTransition & {
  areaSetVersion: number;
};

@Injectable()
export class UserStateRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async lockAndLoad(manager: EntityManager, userIds: string[]): Promise<Map<string, StateRow[]>> {
    const statesByUser = new Map<string, StateRow[]>(userIds.map((userId) => [userId, []]));
    if (userIds.length === 0) {
      return statesByUser;
    }

    const rows = (await manager.query(
      `SELECT user_id, area_id, entered_at, last_inside_at, outside_count, first_outside_at
       FROM user_area_state
       WHERE user_id = ANY($1::text[])
       ORDER BY user_id, area_id
       FOR UPDATE`,
      [userIds],
    )) as StateDatabaseRow[];

    for (const row of rows) {
      const states = statesByUser.get(row.user_id);
      states?.push({
        areaId: row.area_id,
        enteredAt: row.entered_at,
        lastInsideAt: row.last_inside_at,
        outsideCount: row.outside_count,
        firstOutsideAt: row.first_outside_at,
      });
    }

    return statesByUser;
  }

  async applyChanges(
    manager: EntityManager,
    userId: string,
    changes: UserStateChanges,
  ): Promise<void> {
    if (changes.entries.length > 0) {
      const parameters: unknown[] = [];
      const values = changes.entries.map((entry, index) => {
        const offset = index * 4;
        parameters.push(userId, entry.areaId, entry.enteredAt, changes.areaSetVersion);
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
      });

      await manager.query(
        `INSERT INTO area_entries (user_id, area_id, entered_at, area_set_version)
         VALUES ${values.join(', ')}
         ON CONFLICT (user_id, area_id, entered_at) DO NOTHING`,
        parameters,
      );
    }

    if (changes.exits.length > 0) {
      const parameters: unknown[] = [];
      const values = changes.exits.map((exit, index) => {
        const offset = index * 4;
        parameters.push(userId, exit.areaId, exit.enteredAt, exit.exitedAt);
        return `($${offset + 1}, $${offset + 2}::uuid, $${offset + 3}::timestamptz, $${offset + 4}::timestamptz)`;
      });

      await manager.query(
        `UPDATE area_entries AS entry
         SET exited_at = changes.exited_at, exit_reason = 'left'
         FROM (VALUES ${values.join(', ')}) AS changes(user_id, area_id, entered_at, exited_at)
         WHERE entry.user_id = changes.user_id
           AND entry.area_id = changes.area_id
           AND entry.entered_at = changes.entered_at`,
        parameters,
      );
    }

    if (changes.upserts.length > 0) {
      const parameters: unknown[] = [];
      const values = changes.upserts.map((state, index) => {
        const offset = index * 6;
        parameters.push(
          userId,
          state.areaId,
          state.enteredAt,
          state.lastInsideAt,
          state.outsideCount,
          state.firstOutsideAt,
        );
        return `($${offset + 1}, $${offset + 2}::uuid, $${offset + 3}::timestamptz,
                $${offset + 4}::timestamptz, $${offset + 5}, $${offset + 6}::timestamptz)`;
      });

      await manager.query(
        `INSERT INTO user_area_state (
           user_id, area_id, entered_at, last_inside_at, outside_count, first_outside_at
         )
         VALUES ${values.join(', ')}
         ON CONFLICT (user_id, area_id) DO UPDATE SET
           entered_at = EXCLUDED.entered_at,
           last_inside_at = EXCLUDED.last_inside_at,
           outside_count = EXCLUDED.outside_count,
           first_outside_at = EXCLUDED.first_outside_at`,
        parameters,
      );
    }

    if (changes.deletes.length > 0) {
      await manager.query(
        'DELETE FROM user_area_state WHERE user_id = $1 AND area_id = ANY($2::uuid[])',
        [userId, changes.deletes],
      );
    }
  }

  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  async readEntries(userId: string): Promise<AreaEntry[]> {
    return this.dataSource.getRepository(AreaEntry).find({ where: { userId } });
  }

  async readStates(userId: string): Promise<UserAreaState[]> {
    return this.dataSource.getRepository(UserAreaState).find({ where: { userId } });
  }
}

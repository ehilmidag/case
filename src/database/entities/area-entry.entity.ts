import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

export type ExitReason = 'left' | 'timeout' | 'area_deleted';

@Entity({ name: 'area_entries' })
@Unique('area_entries_user_area_entered_at_key', ['userId', 'areaId', 'enteredAt'])
@Index('area_entries_user_entered_at_id_idx', ['userId', 'enteredAt', 'id'])
@Index('area_entries_area_entered_at_id_idx', ['areaId', 'enteredAt', 'id'])
@Index('area_entries_entered_at_id_idx', ['enteredAt', 'id'])
export class AreaEntry {
  // `id` uses a separate identity sequence per partition (a PostgreSQL limitation for
  // partitioned tables), so it is unique within its own partition only, not globally.
  // Safe here because `enteredAt` is the partition key and is always part of any lookup.
  @PrimaryColumn({ type: 'bigint', generated: 'identity' })
  id!: string;

  @Column({ name: 'user_id', type: 'text' })
  userId!: string;

  @Column({ name: 'area_id', type: 'uuid' })
  areaId!: string;

  @PrimaryColumn({ name: 'entered_at', type: 'timestamptz' })
  enteredAt!: Date;

  @Column({ name: 'exited_at', type: 'timestamptz', nullable: true })
  exitedAt!: Date | null;

  @Column({ name: 'exit_reason', type: 'text', nullable: true })
  exitReason!: ExitReason | null;

  @Column({ name: 'area_set_version', type: 'bigint' })
  areaSetVersion!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}

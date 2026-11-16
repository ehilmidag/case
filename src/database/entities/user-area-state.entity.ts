import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Area } from './area.entity';

@Entity({ name: 'user_area_state' })
@Index('user_area_state_last_inside_at_idx', ['lastInsideAt'])
export class UserAreaState {
  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId!: string;

  @PrimaryColumn({ name: 'area_id', type: 'uuid' })
  areaId!: string;

  @ManyToOne(() => Area, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'area_id', referencedColumnName: 'id' })
  area!: Area;

  @Column({ name: 'entered_at', type: 'timestamptz' })
  enteredAt!: Date;

  @Column({ name: 'last_inside_at', type: 'timestamptz' })
  lastInsideAt!: Date;

  @Column({ name: 'outside_count', type: 'integer', default: 0 })
  outsideCount!: number;

  @Column({ name: 'first_outside_at', type: 'timestamptz', nullable: true })
  firstOutsideAt!: Date | null;
}

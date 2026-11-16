import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type GeoJsonPolygon = {
  type: 'Polygon';
  coordinates: [number, number][][];
};

@Entity({ name: 'areas' })
@Index('areas_geom_gix', { synchronize: false })
@Index('areas_created_id_idx', ['createdAt', 'id'])
export class Area {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'geometry', spatialFeatureType: 'Polygon', srid: 4326 })
  geom!: GeoJsonPolygon;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'bigint' })
  version!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}

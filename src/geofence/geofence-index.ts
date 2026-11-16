import { GeoJsonPolygon } from '../database/entities/area.entity';

export type AreaGeometry = {
  id: string;
  geometry: GeoJsonPolygon;
};

export interface GeofenceIndex {
  readonly version: number;
  rebuild(areas: AreaGeometry[], version: number): void;
  findContaining(lat: number, lng: number): string[];
  isUniformCell(cell: string): boolean;
}

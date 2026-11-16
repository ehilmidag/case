import { booleanDisjoint } from '@turf/boolean-disjoint';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { booleanWithin } from '@turf/boolean-within';
import { cellToBoundary } from 'h3-js';
import { GeoJsonPolygon } from '../database/entities/area.entity';
import { AreaGeometry } from './geofence-index';

export type Bounds = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

export type PolygonGeometry = {
  type: 'Polygon';
  coordinates: [number, number][][];
};

export function getBounds(geometry: GeoJsonPolygon): Bounds {
  const positions = geometry.coordinates.flat();
  const longitudes = positions.map(([lng]) => lng);
  const latitudes = positions.map(([, lat]) => lat);

  return {
    minLng: Math.min(...longitudes),
    minLat: Math.min(...latitudes),
    maxLng: Math.max(...longitudes),
    maxLat: Math.max(...latitudes),
  };
}

export function containsPoint(area: AreaGeometry, lat: number, lng: number): boolean {
  return booleanPointInPolygon([lng, lat], area.geometry, { ignoreBoundary: false });
}

export function getCellPolygon(cell: string): PolygonGeometry {
  return {
    type: 'Polygon',
    coordinates: [cellToBoundary(cell, true) as [number, number][]],
  };
}

export function cellIsUniform(cellPolygon: PolygonGeometry, area: AreaGeometry): boolean {
  return booleanWithin(cellPolygon, area.geometry) || booleanDisjoint(cellPolygon, area.geometry);
}

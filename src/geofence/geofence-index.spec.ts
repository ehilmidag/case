import { AreaGeometry } from './geofence-index';
import { H3GeofenceIndex } from './h3-geofence-index';
import { RTreeGeofenceIndex } from './rtree-geofence-index';

function rectangle(
  id: string,
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): AreaGeometry {
  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
          [minLng, minLat],
        ],
      ],
    },
  };
}

describe.each([
  ['R-tree', () => new RTreeGeofenceIndex()],
  ['H3', () => new H3GeofenceIndex(9)],
])('%s geofence index', (_name, createIndex) => {
  const index = createIndex();
  const areas = [rectangle('square', 0, 0, 1, 1)];

  beforeEach(() => index.rebuild(areas, 7));

  it('treats edges and corners as contained and returns deterministic IDs', () => {
    expect(index.findContaining(0.5, 0)).toEqual(['square']);
    expect(index.findContaining(1, 1)).toEqual(['square']);
    expect(index.findContaining(0.5, 0.5)).toEqual(['square']);
    expect(index.findContaining(1.01, 1.01)).toEqual([]);
  });

  it('supports holes, overlapping and nested polygons', () => {
    index.rebuild(
      [
        {
          id: 'holed',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
              [
                [0.25, 0.25],
                [0.25, 0.75],
                [0.75, 0.75],
                [0.75, 0.25],
                [0.25, 0.25],
              ],
            ],
          },
        },
        rectangle('overlap', 0.5, 0.5, 1.5, 1.5),
        rectangle('nested', 0.1, 0.1, 0.2, 0.2),
      ],
      8,
    );

    expect(index.findContaining(0.1, 0.1)).toEqual(['holed', 'nested']);
    expect(index.findContaining(0.5, 0.5)).toEqual(['overlap']);
    expect(index.findContaining(0.9, 0.9)).toEqual(['holed', 'overlap']);
  });

  it('handles thin, long polygons, no-match points, empty sets, and rebuild versions', () => {
    index.rebuild([rectangle('thin', -1, 10, 1, 10.0001)], 9);
    expect(index.findContaining(10.00005, 0)).toEqual(['thin']);
    expect(index.findContaining(10.01, 0)).toEqual([]);

    index.rebuild([], 10);
    expect(index.version).toBe(10);
    expect(index.findContaining(10.00005, 0)).toEqual([]);
  });
});

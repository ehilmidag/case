import * as fc from 'fast-check';
import { cellToLatLng, latLngToCell } from 'h3-js';
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

describe('geofence property invariants', () => {
  const areas = [
    rectangle('west', -0.2, -0.2, -0.1, -0.1),
    rectangle('overlap-a', 0.05, 0.05, 0.2, 0.2),
    rectangle('overlap-b', 0.1, 0.1, 0.25, 0.25),
    rectangle('thin', -0.4, 0.3, 0.4, 0.3001),
  ];
  const rtree = new RTreeGeofenceIndex();
  const h3 = new H3GeofenceIndex(9);

  beforeAll(() => {
    rtree.rebuild(areas, 1);
    h3.rebuild(areas, 1);
  });

  it('returns identical containing areas for 10,000 random points', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -0.5, max: 0.5, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true, noDefaultInfinity: true }),
        (lat, lng) => {
          expect(h3.findContaining(lat, lng)).toEqual(rtree.findContaining(lat, lng));
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('uniform H3 cells always return one stable containment result for 10,000 points', () => {
    const index = new H3GeofenceIndex(9);
    index.rebuild(areas, 1);
    const cell = latLngToCell(0.15, 0.15, 9);
    const [centerLat, centerLng] = cellToLatLng(cell);
    const expected = index.findContaining(centerLat, centerLng);

    expect(index.isUniformCell(cell)).toBe(true);
    expect(expected).toEqual(['overlap-a', 'overlap-b']);
    fc.assert(
      fc.property(
        fc.double({ min: -0.0001, max: 0.0001, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -0.0001, max: 0.0001, noNaN: true, noDefaultInfinity: true }),
        (latOffset, lngOffset) => {
          const lat = centerLat + latOffset;
          const lng = centerLng + lngOffset;

          expect(latLngToCell(lat, lng, 9)).toBe(cell);
          expect(index.findContaining(lat, lng)).toEqual(expected);
          expect(index.isUniformCell(cell)).toBe(true);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

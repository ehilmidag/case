import { validate } from 'class-validator';
import { CreateAreaDto } from './create-area.dto';

const validSquare = {
  type: 'Polygon',
  coordinates: [
    [
      [29, 41],
      [29.01, 41],
      [29.01, 41.01],
      [29, 41.01],
      [29, 41],
    ],
  ],
};

describe('CreateAreaDto GeoJSON validation', () => {
  function createDto(geometry: unknown): CreateAreaDto {
    return Object.assign(new CreateAreaDto(), { name: 'Test area', geometry });
  }

  it('accepts a closed polygon ring with valid longitude/latitude coordinates', async () => {
    await expect(validate(createDto(validSquare))).resolves.toHaveLength(0);
  });

  it('rejects open rings and rings with fewer than four positions', async () => {
    const openRing = structuredClone(validSquare);
    openRing.coordinates[0].pop();
    const shortRing = {
      type: 'Polygon',
      coordinates: [
        [
          [29, 41],
          [29.01, 41],
          [29, 41],
        ],
      ],
    };

    await expect(validate(createDto(openRing))).resolves.not.toHaveLength(0);
    await expect(validate(createDto(shortRing))).resolves.not.toHaveLength(0);
  });

  it('rejects invalid coordinate ranges, malformed positions, and non-polygons', async () => {
    const invalidCoordinates = {
      type: 'Polygon',
      coordinates: [
        [
          [181, 41],
          [29.01, 41],
          [29.01, 41.01],
          [181, 41.01],
          [181, 41],
        ],
      ],
    };
    const malformedPosition = {
      type: 'Polygon',
      coordinates: [
        [
          [29, 41, 5],
          [30, 41],
          [30, 42],
          [29, 42],
          [29, 41, 5],
        ],
      ],
    };

    await expect(validate(createDto(invalidCoordinates))).resolves.not.toHaveLength(0);
    await expect(validate(createDto(malformedPosition))).resolves.not.toHaveLength(0);
    await expect(
      validate(createDto({ type: 'MultiPolygon', coordinates: [] })),
    ).resolves.not.toHaveLength(0);
  });
});

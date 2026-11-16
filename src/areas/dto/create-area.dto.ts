import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { GeoJsonPolygon } from '../../database/entities/area.entity';
import { IsGeoJsonPolygon } from './geojson-polygon.validator';

export class CreateAreaDto {
  @ApiProperty({
    description: 'Human-readable area name, trimmed of surrounding whitespace.',
    maxLength: 255,
    example: 'Kadikoy Center',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 255)
  name!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'GeoJSON Polygon, SRID 4326. Each ring must be closed (first position repeated as last) ' +
      'and within MAX_POLYGON_VERTICES. Rejected with 422 if PostGIS considers the geometry ' +
      'invalid (self-intersecting, etc.) — see ST_IsValidReason in the error response.',
    example: {
      type: 'Polygon',
      coordinates: [
        [
          [29.023, 40.99],
          [29.033, 40.99],
          [29.033, 40.996],
          [29.023, 40.996],
          [29.023, 40.99],
        ],
      ],
    },
  })
  @IsGeoJsonPolygon()
  geometry!: GeoJsonPolygon;
}

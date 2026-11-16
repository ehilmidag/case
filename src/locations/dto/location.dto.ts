import { IsDateString, IsNumber, IsString, Length, Matches, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LocationDto {
  @ApiProperty({
    description: 'Opaque client-supplied identifier for the user this point belongs to.',
    minLength: 1,
    maxLength: 128,
    example: 'user-1',
  })
  @IsString()
  @Length(1, 128)
  userId!: string;

  @ApiProperty({
    description: 'WGS84 latitude in degrees.',
    minimum: -90,
    maximum: 90,
    example: 40.99,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({
    description: 'WGS84 longitude in degrees.',
    minimum: -180,
    maximum: 180,
    example: 29.03,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiProperty({
    description:
      'Client-side capture time, ISO-8601 UTC (either a "Z" suffix or an explicit "+00:00" offset — other offsets are rejected). Entry/exit timestamps are derived from this, not server receive time.',
    example: '2026-11-16T10:00:00.000Z',
  })
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/)
  timestamp!: string;
}

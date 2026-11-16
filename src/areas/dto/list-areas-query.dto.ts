import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListAreasQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum number of areas to return in one page.',
    minimum: 1,
    maximum: 500,
    default: 50,
  })
  @Transform(({ value }) => (value === undefined ? 50 : Number(value)))
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 50;

  @ApiPropertyOptional({
    description:
      'Opaque base64 keyset cursor from a previous response\'s "nextCursor" — pass it back ' +
      'unmodified to fetch the next page. Omit for the first page.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'minLng,minLat,maxLng,maxLat — only areas whose bounds intersect this box.',
    example: '29.0,40.9,29.1,41.0',
  })
  @IsOptional()
  @IsString()
  bbox?: string;
}

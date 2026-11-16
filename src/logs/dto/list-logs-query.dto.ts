import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListLogsQueryDto {
  @ApiPropertyOptional({ description: 'Filter to entry/exit records for this user.' })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  userId?: string;

  @ApiPropertyOptional({ description: 'Filter to entry/exit records for this area.' })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiPropertyOptional({ description: 'ISO-8601, inclusive lower bound on entered_at' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601, exclusive upper bound on entered_at' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of log entries to return in one page.',
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
      'unmodified to fetch the next page.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

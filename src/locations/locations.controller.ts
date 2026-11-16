import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { IngestBackpressureFilter } from './ingest-backpressure.filter';
import { LocationsThrottlerGuard } from './locations-throttler.guard';
import { IngestService } from './ingest.service';
import {
  LocationParseResult,
  LocationValidationError,
  parseLocationRequest,
} from './location-payload';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';

@ApiTags('locations')
@Controller('locations')
@UseGuards(LocationsThrottlerGuard)
@UseFilters(IngestBackpressureFilter)
export class LocationsController {
  constructor(
    private readonly ingestService: IngestService,
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Accept one location or a batch of locations',
    description:
      'Validates and enqueues points for asynchronous geofence evaluation; does not wait for ' +
      'worker processing. Accepts either a single location object or a {"locations": [...]} ' +
      'batch of up to MAX_BATCH_LOCATIONS points. Points are validated and accepted ' +
      'independently — one invalid point in a batch does not drop the others. Always check ' +
      '"rejected" in the response, even on 202; it is empty when every point was accepted.',
  })
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['userId', 'latitude', 'longitude', 'timestamp'],
          properties: {
            userId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description: 'Opaque client-supplied user identifier.',
            },
            latitude: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'WGS84 latitude in degrees.',
            },
            longitude: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'WGS84 longitude in degrees.',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              description:
                'ISO-8601 UTC capture time ("Z" suffix or explicit "+00:00"); entry/exit times ' +
                'are derived from this, not server receive time.',
            },
          },
        },
        {
          type: 'object',
          required: ['locations'],
          properties: {
            locations: {
              type: 'array',
              items: { type: 'object' },
              description: 'Up to MAX_BATCH_LOCATIONS location objects, each shaped as above.',
            },
          },
        },
      ],
    },
  })
  @ApiAcceptedResponse({
    description:
      'At least one point was accepted and enqueued. "rejected" lists any points in the same ' +
      'request that failed validation (empty if all were accepted) — a 202 does not guarantee ' +
      'every point in the request was processed.',
    schema: {
      example: {
        accepted: 1,
        rejected: [
          { index: 1, field: 'latitude', messages: ['latitude must not be greater than 90'] },
        ],
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Either the request shape itself is malformed (not an object, unsupported fields, ' +
      'locations not a non-empty array, or batch exceeds MAX_BATCH_LOCATIONS — none of which ' +
      'can be partially accepted), or every single point in the request failed validation.',
    schema: {
      example: {
        statusCode: 400,
        message: 'Validation failed.',
        errors: [
          { index: 0, field: 'latitude', messages: ['latitude must not be greater than 90'] },
        ],
      },
    },
  })
  @ApiTooManyRequestsResponse({
    description: 'Per-IP or per-user RATE_LIMIT_PER_MIN exceeded.',
    schema: { example: { statusCode: 429, message: 'ThrottlerException: Too Many Requests' } },
  })
  @ApiServiceUnavailableResponse({
    description:
      'Ingestion is temporarily backpressured (queue depth at BACKPRESSURE_MAX_PENDING, or ' +
      'Redis unavailable). Retry after the seconds given in the Retry-After header.',
    schema: {
      example: { statusCode: 503, message: 'Location ingestion is temporarily backpressured.' },
    },
  })
  async ingest(
    @Body() payload: unknown,
  ): Promise<{ accepted: number; rejected: LocationValidationError[] }> {
    let parsed: LocationParseResult;
    try {
      parsed = await parseLocationRequest(payload, {
        MAX_BATCH_LOCATIONS: this.configService.getOrThrow<number>('MAX_BATCH_LOCATIONS'),
        TS_MAX_PAST_MS: this.configService.getOrThrow<number>('TS_MAX_PAST_MS'),
        TS_MAX_FUTURE_MS: this.configService.getOrThrow<number>('TS_MAX_FUTURE_MS'),
      });
    } catch (error) {
      this.metrics.locationsRejectedTotal.inc({ reason: 'validation' });
      throw error;
    }

    const { points, errors } = parsed;
    if (errors.length > 0) {
      this.metrics.locationsRejectedTotal.inc({ reason: 'validation' }, errors.length);
    }

    if (points.length === 0) {
      throw new BadRequestException({ message: 'Validation failed.', errors });
    }

    const accepted = await this.ingestService.ingest(points);
    return { accepted, rejected: errors };
  }
}

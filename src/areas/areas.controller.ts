import { Body, Controller, Get, Headers, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CreateAreaDto } from './dto/create-area.dto';
import { ListAreasQueryDto } from './dto/list-areas-query.dto';
import { AreasService } from './areas.service';

@ApiTags('areas')
@Controller('areas')
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a geofence area',
    description:
      'Areas can only be created, never updated or deleted (see README "Kapsam Dışı"). ' +
      'Version is assigned from a single monotonic sequence and is only used to detect ' +
      "whether a worker's in-memory geofence index needs rebuilding.",
  })
  @ApiBody({ type: CreateAreaDto })
  @ApiCreatedResponse({
    description: 'Created GeoJSON Feature',
    schema: {
      example: {
        type: 'Feature',
        id: '1a7e0ef6-19f8-49aa-9d01-da34508636d4',
        geometry: {
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
        properties: { name: 'Kadikoy Center', createdAt: '2026-11-14T19:00:00.000Z', version: 7 },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Field failed validation, or the polygon exceeds MAX_POLYGON_VERTICES.',
    schema: {
      example: {
        statusCode: 400,
        message: ['geometry must be a closed GeoJSON Polygon with valid coordinate ranges'],
        error: 'Bad Request',
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The geometry is a well-formed GeoJSON Polygon but PostGIS rejects it as invalid (e.g. self-intersecting).',
    schema: {
      example: {
        statusCode: 422,
        message: 'Invalid polygon',
        reason: 'Self-intersection at or near point 29.03 40.99',
      },
    },
  })
  async create(@Body() dto: CreateAreaDto, @Res() response: Response): Promise<void> {
    const feature = await this.areasService.create(dto);
    response.status(201).location(`/areas/${feature.id}`).json(feature);
  }

  @Get()
  @ApiOperation({
    summary: 'List geofence areas',
    description:
      'Keyset-paginated (not OFFSET-based, so pages stay fast regardless of table size). ' +
      'Returns an ETag derived from the result set; send it back as If-None-Match to get a ' +
      '304 when nothing has changed.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of areas to return in this page.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'Opaque keyset cursor from a previous response\'s "nextCursor".',
  })
  @ApiQuery({
    name: 'bbox',
    required: false,
    type: String,
    description: 'minLng,minLat,maxLng,maxLat — only areas whose bounds intersect this box.',
  })
  @ApiBadRequestResponse({
    description:
      'bbox is malformed or out of coordinate range, or cursor is not a valid opaque cursor.',
    schema: {
      example: {
        statusCode: 400,
        message: 'bbox must be minLng,minLat,maxLng,maxLat within coordinate ranges',
        error: 'Bad Request',
      },
    },
  })
  @ApiOkResponse({
    description: 'GeoJSON FeatureCollection',
    schema: {
      example: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: '1a7e0ef6-19f8-49aa-9d01-da34508636d4',
            geometry: {
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
            properties: {
              name: 'Kadikoy Center',
              createdAt: '2026-11-14T19:00:00.000Z',
              version: 7,
            },
          },
        ],
        nextCursor: null,
      },
    },
  })
  @ApiResponse({ status: 304, description: 'The current representation matches If-None-Match' })
  async list(
    @Query() query: ListAreasQueryDto,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.areasService.list(query, ifNoneMatch);
    response.setHeader('ETag', result.etag);
    if (result.notModified) {
      response.status(304).end();
      return;
    }

    response.status(200).json(result.collection);
  }
}

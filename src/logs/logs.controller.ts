import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ListLogsQueryDto } from './dto/list-logs-query.dto';
import { LogPage, LogsService } from './logs.service';

@ApiTags('logs')
@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Get()
  @ApiOperation({
    summary: 'List area entry/exit logs',
    description:
      'Reads from the read replica when DATABASE_READ_URL is configured (eventual ' +
      'consistency). If neither "from" nor "to" is given, defaults to the last 30 days so a ' +
      'query never has to scan every partition.',
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    type: String,
    description: 'Filter to entry/exit records for this user.',
  })
  @ApiQuery({
    name: 'areaId',
    required: false,
    type: String,
    description: 'Filter to entry/exit records for this area (UUID).',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'ISO-8601, inclusive lower bound on entered_at. Defaults to 30 days ago.',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'ISO-8601, exclusive upper bound on entered_at. Defaults to now.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of log entries to return in this page.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'Opaque keyset cursor from a previous response\'s "nextCursor".',
  })
  @ApiBadRequestResponse({
    description: 'cursor is not a valid opaque logs cursor, or areaId is not a UUID.',
    schema: {
      example: {
        statusCode: 400,
        message: 'cursor must be a valid opaque logs cursor',
        error: 'Bad Request',
      },
    },
  })
  @ApiOkResponse({
    description: 'Page of area entry/exit logs',
    schema: {
      example: {
        items: [
          {
            id: '123',
            userId: 'u-123',
            areaId: '1a7e0ef6-19f8-49aa-9d01-da34508636d4',
            entryTime: '2026-11-14T19:00:00.000Z',
            exitTime: null,
            exitReason: null,
          },
        ],
        nextCursor: null,
      },
    },
  })
  async list(@Query() query: ListLogsQueryDto): Promise<LogPage> {
    return this.logsService.list(query);
  }
}

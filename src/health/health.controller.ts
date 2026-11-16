import { Controller, Get, Optional } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckError,
  HealthCheckService,
  HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AreaIndexManager } from '../geofence/area-index.manager';
import { RedisHealthIndicator } from './redis-health.indicator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    @Optional() private readonly areaIndexManager?: AreaIndexManager,
  ) {}

  @Get('live')
  @HealthCheck()
  @ApiOperation({
    summary: 'Process liveness check',
    description:
      'Checks only that the process is up and the event loop is responsive — no dependency ' +
      'calls. A Kubernetes liveness probe should restart the pod if this ever fails; it never ' +
      'fails on a dependency outage, only on the process itself being wedged.',
  })
  @ApiOkResponse({ schema: { example: { status: 'ok', info: {}, error: {}, details: {} } } })
  checkLiveness() {
    return this.healthCheckService.check([]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Dependency readiness check',
    description:
      'Checks the database and Redis; a Kubernetes readiness probe should stop routing ' +
      'traffic to this pod if this fails. On the worker process only (this controller is ' +
      'shared between API and worker — see README "Mimari"), also requires the in-memory ' +
      'geofence index to have completed at least one load, since no point can be safely ' +
      "evaluated before that; the API's response never includes this check.",
  })
  @ApiOkResponse({
    description: 'All checked dependencies are up. On the worker, also includes geofenceIndex.',
    schema: {
      example: {
        status: 'ok',
        info: { database: { status: 'up' }, redis: { status: 'up' } },
        error: {},
        details: { database: { status: 'up' }, redis: { status: 'up' } },
      },
    },
  })
  @ApiServiceUnavailableResponse({
    description:
      'At least one dependency is down (or, on the worker, the geofence index has not loaded yet).',
    schema: {
      example: {
        status: 'error',
        info: { database: { status: 'up' } },
        error: { redis: { status: 'down', message: 'connect ECONNREFUSED' } },
        details: {
          database: { status: 'up' },
          redis: { status: 'down', message: 'connect ECONNREFUSED' },
        },
      },
    },
  })
  checkReadiness() {
    const areaIndexManager = this.areaIndexManager;
    return this.healthCheckService.check([
      () => this.db.pingCheck('database'),
      () => this.redis.check('redis'),
      ...(areaIndexManager ? [() => this.checkGeofenceIndex(areaIndexManager)] : []),
    ]);
  }

  // The worker can't safely evaluate any point until its geofence index has loaded at
  // least once — readiness must say "not ready" until then, same as a missing DB/Redis
  // connection would. AreaIndexManager is only injected at all in the worker (see
  // GeofenceModule), so this check is skipped entirely for the API.
  private checkGeofenceIndex(areaIndexManager: AreaIndexManager): HealthIndicatorResult {
    try {
      void areaIndexManager.current;
      return { geofenceIndex: { status: 'up' } };
    } catch {
      throw new HealthCheckError('Geofence index not loaded', {
        geofenceIndex: { status: 'down' },
      });
    }
  }
}

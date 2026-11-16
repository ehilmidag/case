import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { AreaIndexManager } from './area-index.manager';

// Global so the worker's HealthController can @Optional()-inject AreaIndexManager for
// the readiness check without HealthModule (shared with the API, which never imports
// this module) needing to import GeofenceModule directly.
@Global()
@Module({
  imports: [RedisModule],
  providers: [AreaIndexManager],
  exports: [AreaIndexManager],
})
export class GeofenceModule {}

import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './common/logging.module';
import { DatabaseModule } from './database/database.module';
import { GeofenceModule } from './geofence/geofence.module';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsModule } from './metrics/metrics.module';
import { StateModule } from './state/state.module';
import { WorkerModule } from './worker/worker.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    LoggingModule,
    MetricsModule,
    HealthModule,
    GeofenceModule,
    StateModule,
    WorkerModule,
  ],
  controllers: [MetricsController],
})
export class AppWorkerModule {}

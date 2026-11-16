import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './common/logging.module';
import { DatabaseModule } from './database/database.module';
import { AreasModule } from './areas/areas.module';
import { LocationsModule } from './locations/locations.module';
import { LogsModule } from './logs/logs.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    LoggingModule,
    MetricsModule,
    HealthModule,
    AreasModule,
    LocationsModule,
    LogsModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          whitelist: true,
          transform: true,
          forbidNonWhitelisted: true,
        }),
    },
  ],
})
export class AppApiModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BackpressureMonitor } from './backpressure-monitor.service';
import { IngestService } from './ingest.service';
import { LocationsController } from './locations.controller';
import { getIpRateLimitKey, getUserRateLimitKey } from './rate-limit-tracker';
import { LocationsThrottlerGuard } from './locations-throttler.guard';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const limit = configService.getOrThrow<number>('RATE_LIMIT_PER_MIN');
        return [
          {
            name: 'ip',
            ttl: 60_000,
            limit,
            getTracker: (request: Record<string, unknown>) => getIpRateLimitKey(request),
          },
          {
            name: 'user',
            ttl: 60_000,
            limit,
            getTracker: (request: Record<string, unknown>) => getUserRateLimitKey(request),
          },
        ];
      },
    }),
  ],
  controllers: [LocationsController],
  providers: [IngestService, BackpressureMonitor, LocationsThrottlerGuard],
  exports: [IngestService],
})
export class LocationsModule {}

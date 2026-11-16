import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createDatabaseOptions } from './database-options';

// Global so Terminus's TypeOrmHealthIndicator (used by HealthModule's readiness check)
// can resolve the DataSource without HealthModule needing to import this module itself.
// Both app modules already import DatabaseModule unconditionally, so this doesn't change
// where it gets instantiated — just where its exports are reachable from.
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createDatabaseOptions({
          DATABASE_URL: configService.getOrThrow<string>('DATABASE_URL'),
          DATABASE_READ_URL: configService.get<string>('DATABASE_READ_URL') ?? '',
        }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}

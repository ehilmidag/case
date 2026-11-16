import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Area } from '../database/entities/area.entity';
import { RedisModule } from '../redis/redis.module';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';
import { GeoJsonPolygonConstraint } from './dto/geojson-polygon.validator';

@Module({
  imports: [TypeOrmModule.forFeature([Area]), RedisModule],
  controllers: [AreasController],
  providers: [AreasService, GeoJsonPolygonConstraint],
})
export class AreasModule {}

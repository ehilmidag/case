import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AreaEntry } from '../database/entities/area-entry.entity';
import { UserAreaState } from '../database/entities/user-area-state.entity';
import { RedisModule } from '../redis/redis.module';
import { RedisFilter } from './redis-filter';
import { UserStateRepository } from './user-state.repository';

@Module({
  imports: [TypeOrmModule.forFeature([AreaEntry, UserAreaState]), RedisModule],
  providers: [RedisFilter, UserStateRepository],
  exports: [RedisFilter, UserStateRepository],
})
export class StateModule {}

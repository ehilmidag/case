import { Module } from '@nestjs/common';
import { GeofenceModule } from '../geofence/geofence.module';
import { RedisModule } from '../redis/redis.module';
import { StateModule } from '../state/state.module';
import { BatchProcessorService } from './batch-processor.service';
import { FaultInjector } from './fault-injector';
import { PartitionLeaseService } from './partition-lease.service';
import { StreamConsumerService } from './stream-consumer.service';
import { TimeoutSweeperService } from './timeout-sweeper.service';

@Module({
  imports: [RedisModule, GeofenceModule, StateModule],
  providers: [
    PartitionLeaseService,
    BatchProcessorService,
    StreamConsumerService,
    TimeoutSweeperService,
    FaultInjector,
  ],
  exports: [FaultInjector],
})
export class WorkerModule {}

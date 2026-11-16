import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

// One shared registry per process (API and worker each get their own instance of this
// service). Only the metrics each process actually touches move; the rest just stay at
// their initial value, which Prometheus treats as "no activity of that kind" — harmless.
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly locationsIngestedTotal = new Counter({
    name: 'locations_ingested_total',
    help: 'Location points accepted by POST /locations.',
    registers: [this.registry],
  });

  readonly locationsRejectedTotal = new Counter({
    name: 'locations_rejected_total',
    help: 'Location points rejected by POST /locations, by reason.',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  readonly streamPendingMessages = new Gauge({
    name: 'stream_pending_messages',
    help: 'Pending (unacked) messages per location stream partition.',
    labelNames: ['partition'],
    registers: [this.registry],
  });

  readonly workerBatchDurationSeconds = new Histogram({
    name: 'worker_batch_duration_seconds',
    help: 'Time to fully process one worker batch (geofence + DB transaction + filter update).',
    registers: [this.registry],
  });

  readonly workerPointsProcessedTotal = new Counter({
    name: 'worker_points_processed_total',
    help: 'Location points processed by the worker, by outcome.',
    labelNames: ['result'],
    registers: [this.registry],
  });

  readonly areaEntriesCreatedTotal = new Counter({
    name: 'area_entries_created_total',
    help: 'Area entry records created.',
    registers: [this.registry],
  });

  readonly areaExitsTotal = new Counter({
    name: 'area_exits_total',
    help: 'Area exits recorded, by reason.',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  readonly dlqMessagesTotal = new Counter({
    name: 'dlq_messages_total',
    help: 'Messages moved to the dead-letter stream after exhausting delivery attempts.',
    registers: [this.registry],
  });

  readonly geofenceIndexVersion = new Gauge({
    name: 'geofence_index_version',
    help: 'area_set_version currently loaded into the in-memory geofence index.',
    registers: [this.registry],
  });

  readonly partitionLeasesHeld = new Gauge({
    name: 'partition_leases_held',
    help: 'Number of stream partitions this worker instance currently holds a lease for.',
    registers: [this.registry],
  });

  async exposition(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

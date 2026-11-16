import { MetricsService } from './metrics.service';

const PLANNED_METRIC_NAMES = [
  'locations_ingested_total',
  'locations_rejected_total',
  'stream_pending_messages',
  'worker_batch_duration_seconds',
  'worker_points_processed_total',
  'area_entries_created_total',
  'area_exits_total',
  'dlq_messages_total',
  'geofence_index_version',
  'partition_leases_held',
];

describe('MetricsService', () => {
  it('exposes every metric planned for Faz 9.1 via its registry', async () => {
    const metrics = new MetricsService();
    const exposition = await metrics.exposition();

    for (const name of PLANNED_METRIC_NAMES) {
      expect(exposition).toContain(`# HELP ${name} `);
    }
  });

  it('reflects counter increments and gauge updates in the exposition text', async () => {
    const metrics = new MetricsService();
    metrics.locationsIngestedTotal.inc(3);
    metrics.locationsRejectedTotal.inc({ reason: 'validation' });
    metrics.geofenceIndexVersion.set(7);
    metrics.streamPendingMessages.set({ partition: '0' }, 42);

    const exposition = await metrics.exposition();

    expect(exposition).toContain('locations_ingested_total 3');
    expect(exposition).toContain('locations_rejected_total{reason="validation"} 1');
    expect(exposition).toContain('geofence_index_version 7');
    expect(exposition).toContain('stream_pending_messages{partition="0"} 42');
  });

  it('exposes the correct Prometheus exposition content type', () => {
    const metrics = new MetricsService();
    expect(metrics.contentType).toContain('text/plain');
  });
});

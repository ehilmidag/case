import { QueryRunner } from 'typeorm';

export async function ensureEntryPartitions(
  queryRunner: Pick<QueryRunner, 'query'>,
  referenceDate = new Date(),
  months = 4,
): Promise<void> {
  const firstMonth = Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1);

  for (let offset = 0; offset < months; offset += 1) {
    const start = new Date(firstMonth);
    start.setUTCMonth(start.getUTCMonth() + offset);
    const end = new Date(firstMonth);
    end.setUTCMonth(end.getUTCMonth() + offset + 1);

    const suffix = `${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    const partitionName = `area_entries_${suffix}`;

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "${partitionName}" PARTITION OF "area_entries"
       FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
    );
  }
}

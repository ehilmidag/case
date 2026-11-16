import { AppDataSource } from './data-source';
import { initializeWithRetry } from './initialize-with-retry';
import { ensureEntryPartitions } from './migrations/entry-partitions';

async function ensurePartitions(): Promise<void> {
  await initializeWithRetry(AppDataSource);
  const queryRunner = AppDataSource.createQueryRunner();

  try {
    await queryRunner.connect();
    await ensureEntryPartitions(queryRunner);
    process.stdout.write('Ensured current and next three area entry partitions.\n');
  } finally {
    await queryRunner.release();
    await AppDataSource.destroy();
  }
}

void ensurePartitions().catch((error: unknown) => {
  process.stderr.write(`Partition maintenance failed: ${String(error)}\n`);
  process.exitCode = 1;
});

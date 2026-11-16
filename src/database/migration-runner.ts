import { AppDataSource } from './data-source';
import { initializeWithRetry } from './initialize-with-retry';

async function run(): Promise<void> {
  await initializeWithRetry(AppDataSource);

  try {
    if (process.argv[2] === 'revert') {
      await AppDataSource.undoLastMigration();
      process.stdout.write('Last database migration reverted.\n');
      return;
    }

    const migrations = await AppDataSource.runMigrations();
    process.stdout.write(`Applied ${migrations.length} database migration(s).\n`);
  } finally {
    await AppDataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`Database migration failed: ${String(error)}\n`);
  process.exitCode = 1;
});

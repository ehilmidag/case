import { DataSource } from 'typeorm';

// Postgres can refuse connections for a while after its healthcheck first passes: the
// official image's entrypoint runs `pg_isready` against a temporary server it uses to
// execute init scripts (extensions, etc.), then stops and restarts with its final
// configuration once those scripts finish — which can take tens of seconds. One-shot
// scripts (migrations, partition maintenance) run outside of NestJS's TypeOrmModule,
// which already retries on its own, so they need their own retry.
export async function initializeWithRetry(
  dataSource: DataSource,
  attempts = 40,
  delayMs = 3000,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await dataSource.initialize();
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      process.stderr.write(
        `Database connection attempt ${attempt}/${attempts} failed, retrying in ${delayMs}ms...\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

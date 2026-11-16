import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../database-options';
import { ensureEntryPartitions } from './entry-partitions';

describe('initial PostGIS schema migration (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  const postgisImage =
    process.arch === 'arm64' ? 'ghcr.io/baosystems/postgis:16-3.4' : 'postgis/postgis:16-3.4';

  beforeAll(async () => {
    container = await new PostgreSqlContainer(postgisImage)
      .withDatabase('locations')
      .withUsername('app')
      .withPassword('app')
      .withHealthCheck({
        test: [
          'CMD-SHELL',
          'PGPASSWORD=app pg_isready --host localhost --username app --dbname locations',
        ],
        interval: 250,
        timeout: 1000,
        retries: 1000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();

    const url = container.getConnectionUri();
    dataSource = new DataSource(
      createDatabaseOptions({ DATABASE_URL: url, DATABASE_READ_URL: '' }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 180000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await container?.stop();
  }, 60000);

  it('creates PostGIS, the schema, default partition, and four monthly partitions', async () => {
    const extensions: Array<{ extname: string }> = await dataSource.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pgcrypto') ORDER BY extname",
    );
    expect(extensions.map(({ extname }) => extname)).toEqual(['pgcrypto', 'postgis']);

    const partitions: Array<{ relname: string }> = await dataSource.query(`
      SELECT child.relname
      FROM pg_inherits
      JOIN pg_class parent ON parent.oid = inhparent
      JOIN pg_class child ON child.oid = inhrelid
      WHERE parent.relname = 'area_entries'
    `);
    expect(partitions).toHaveLength(5);
    expect(partitions.map(({ relname }) => relname)).toContain('area_entries_default');

    const tables: Array<{ table_name: string }> = await dataSource.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('areas', 'area_entries', 'user_area_state')
    `);
    expect(tables).toHaveLength(3);
  });

  it('rejects invalid polygons with the ST_IsValid check constraint', async () => {
    await expect(
      dataSource.query(`
        INSERT INTO areas (name, geom, version)
        VALUES (
          'self-intersecting',
          ST_GeomFromText('POLYGON((0 0, 1 1, 1 0, 0 1, 0 0))', 4326),
          1
        )
      `),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ensures the current and next three partitions idempotently', async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const before: Array<{ count: string }> = await queryRunner.query(
        "SELECT count(*) FROM pg_inherits WHERE inhparent = 'area_entries'::regclass",
      );
      await ensureEntryPartitions(queryRunner);
      await ensureEntryPartitions(queryRunner);
      const after: Array<{ count: string }> = await queryRunner.query(
        "SELECT count(*) FROM pg_inherits WHERE inhparent = 'area_entries'::regclass",
      );

      expect(after[0].count).toBe(before[0].count);
    } finally {
      await queryRunner.release();
    }
  });

  it('can roll the migration back and apply it again', async () => {
    await dataSource.undoLastMigration();
    const [result]: Array<{ areas: string | null }> = await dataSource.query(
      "SELECT to_regclass('public.areas') AS areas",
    );
    expect(result.areas).toBeNull();

    await dataSource.runMigrations();
    const [reapplied]: Array<{ areas: string | null }> = await dataSource.query(
      "SELECT to_regclass('public.areas') AS areas",
    );
    expect(reapplied.areas).toBe('areas');
  });
});

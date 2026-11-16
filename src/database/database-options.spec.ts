import { createDatabaseOptions } from './database-options';

describe('createDatabaseOptions', () => {
  it('disables schema synchronization and uses the primary when no read URL is set', () => {
    const options = createDatabaseOptions({
      DATABASE_URL: 'postgres://primary:secret@db.example/locations',
      DATABASE_READ_URL: '',
    });

    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);

    if (options.type !== 'postgres') {
      throw new Error('Expected PostgreSQL TypeORM options.');
    }

    const replication = options.replication;
    if (!replication) {
      throw new Error('Expected PostgreSQL replication options.');
    }

    expect(replication.master.url).toBe('postgres://primary:secret@db.example/locations');
    expect(replication.slaves).toEqual([{ url: 'postgres://primary:secret@db.example/locations' }]);
  });

  it('uses the configured read URL for replica connections', () => {
    const options = createDatabaseOptions({
      DATABASE_URL: 'postgres://primary:secret@db.example/locations',
      DATABASE_READ_URL: 'postgres://replica:secret@db.example/locations',
    });

    if (options.type !== 'postgres') {
      throw new Error('Expected PostgreSQL TypeORM options.');
    }

    const replication = options.replication;
    if (!replication) {
      throw new Error('Expected PostgreSQL replication options.');
    }

    expect(replication.master.url).toBe('postgres://primary:secret@db.example/locations');
    expect(replication.slaves).toEqual([{ url: 'postgres://replica:secret@db.example/locations' }]);
  });
});

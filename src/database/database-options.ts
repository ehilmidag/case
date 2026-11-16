import { DataSourceOptions } from 'typeorm';
import { EnvironmentConfig } from '../config/configuration';
import { Area } from './entities/area.entity';
import { AreaEntry } from './entities/area-entry.entity';
import { UserAreaState } from './entities/user-area-state.entity';
import { InitialSchema1763140000000 } from './migrations/InitialSchema1763140000000';

export function createDatabaseOptions(
  config: Pick<EnvironmentConfig, 'DATABASE_URL' | 'DATABASE_READ_URL'>,
): DataSourceOptions {
  const readUrl = config.DATABASE_READ_URL || config.DATABASE_URL;

  return {
    type: 'postgres',
    replication: {
      master: { url: config.DATABASE_URL },
      slaves: [{ url: readUrl }],
    },
    entities: [Area, AreaEntry, UserAreaState],
    migrations: [InitialSchema1763140000000],
    synchronize: false,
    migrationsRun: false,
  };
}

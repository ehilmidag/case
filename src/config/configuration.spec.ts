import { validateEnvironment } from './configuration';

describe('validateEnvironment', () => {
  const requiredValues = {
    DATABASE_URL: 'postgres://app:app@localhost:5432/locations',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('applies the planned defaults', () => {
    const config = validateEnvironment(requiredValues);

    expect(config.STREAM_PARTITIONS).toBe(16);
    expect(config.GEOFENCE_INDEX).toBe('rtree');
    expect(config.DATABASE_READ_URL).toBe('');
  });

  it('reports missing connection settings', () => {
    expect(() => validateEnvironment({})).toThrow('DATABASE_URL');
    expect(() => validateEnvironment({})).toThrow('REDIS_URL');
  });

  it('rejects invalid time threshold relationships', () => {
    expect(() => validateEnvironment({ ...requiredValues, STATE_REFRESH_MS: 600000 })).toThrow(
      'STATE_REFRESH_MS must be less than SIGNAL_TIMEOUT_MS',
    );
    expect(() => validateEnvironment({ ...requiredValues, FORCE_EVAL_MS: 300000 })).toThrow(
      'FORCE_EVAL_MS must be less than STATE_REFRESH_MS',
    );
  });
});

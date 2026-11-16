import Joi from 'joi';

export interface EnvironmentConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  API_PORT: number;
  METRICS_PORT: number;
  DATABASE_URL: string;
  DATABASE_READ_URL: string;
  REDIS_URL: string;
  STREAM_PARTITIONS: number;
  STREAM_MAXLEN: number;
  BACKPRESSURE_MAX_PENDING: number;
  WORKER_BATCH_SIZE: number;
  WORKER_BLOCK_MS: number;
  PARTITION_LEASE_TTL_MS: number;
  PARTITION_LEASE_RENEW_MS: number;
  MAX_DELIVERY_ATTEMPTS: number;
  GEOFENCE_INDEX: 'rtree' | 'h3';
  H3_INDEX_RESOLUTION: number;
  H3_SKIP_RESOLUTION: number;
  AREA_INDEX_REFRESH_MS: number;
  EXIT_CONFIRM_POINTS: number;
  EXIT_CONFIRM_MS: number;
  FORCE_EVAL_MS: number;
  STATE_REFRESH_MS: number;
  SIGNAL_TIMEOUT_MS: number;
  SWEEPER_INTERVAL_MS: number;
  USER_FILTER_TTL_S: number;
  TS_MAX_FUTURE_MS: number;
  TS_MAX_PAST_MS: number;
  MAX_BATCH_LOCATIONS: number;
  MAX_POLYGON_VERTICES: number;
  RATE_LIMIT_PER_MIN: number;
}

const positiveInteger = (defaultValue: number): Joi.NumberSchema =>
  Joi.number().integer().min(1).default(defaultValue);

const environmentSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  API_PORT: Joi.number().integer().min(1).max(65535).default(3000),
  METRICS_PORT: Joi.number().integer().min(1).max(65535).default(9100),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DATABASE_READ_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .allow('')
    .default(''),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  STREAM_PARTITIONS: positiveInteger(16),
  STREAM_MAXLEN: positiveInteger(2000000),
  BACKPRESSURE_MAX_PENDING: positiveInteger(500000),
  WORKER_BATCH_SIZE: positiveInteger(500),
  WORKER_BLOCK_MS: positiveInteger(1000),
  PARTITION_LEASE_TTL_MS: positiveInteger(15000),
  PARTITION_LEASE_RENEW_MS: positiveInteger(5000),
  MAX_DELIVERY_ATTEMPTS: positiveInteger(5),
  GEOFENCE_INDEX: Joi.string().valid('rtree', 'h3').default('rtree'),
  H3_INDEX_RESOLUTION: Joi.number().integer().min(0).max(15).default(9),
  H3_SKIP_RESOLUTION: Joi.number().integer().min(0).max(15).default(11),
  AREA_INDEX_REFRESH_MS: positiveInteger(30000),
  EXIT_CONFIRM_POINTS: positiveInteger(3),
  EXIT_CONFIRM_MS: positiveInteger(30000),
  FORCE_EVAL_MS: positiveInteger(60000),
  STATE_REFRESH_MS: positiveInteger(300000),
  SIGNAL_TIMEOUT_MS: positiveInteger(600000),
  SWEEPER_INTERVAL_MS: positiveInteger(60000),
  USER_FILTER_TTL_S: positiveInteger(3600),
  TS_MAX_FUTURE_MS: positiveInteger(60000),
  TS_MAX_PAST_MS: positiveInteger(86400000),
  MAX_BATCH_LOCATIONS: positiveInteger(100),
  MAX_POLYGON_VERTICES: positiveInteger(10000),
  RATE_LIMIT_PER_MIN: positiveInteger(120),
}).unknown(true);

export function validateEnvironment(values: Record<string, unknown>): EnvironmentConfig {
  const { error, value } = environmentSchema.validate(values, { abortEarly: false });

  if (error) {
    throw new Error(`Configuration validation failed: ${error.message}`);
  }

  const config = value as EnvironmentConfig;

  if (config.STATE_REFRESH_MS >= config.SIGNAL_TIMEOUT_MS) {
    throw new Error(
      'Configuration validation failed: STATE_REFRESH_MS must be less than SIGNAL_TIMEOUT_MS.',
    );
  }

  if (config.FORCE_EVAL_MS >= config.STATE_REFRESH_MS) {
    throw new Error(
      'Configuration validation failed: FORCE_EVAL_MS must be less than STATE_REFRESH_MS.',
    );
  }

  return config;
}

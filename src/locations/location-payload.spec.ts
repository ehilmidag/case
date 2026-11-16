import { BadRequestException } from '@nestjs/common';
import { EnvironmentConfig } from '../config/configuration';
import { parseLocationRequest } from './location-payload';

const config = {
  MAX_BATCH_LOCATIONS: 2,
  TS_MAX_PAST_MS: 60_000,
  TS_MAX_FUTURE_MS: 10_000,
} satisfies Pick<EnvironmentConfig, 'MAX_BATCH_LOCATIONS' | 'TS_MAX_PAST_MS' | 'TS_MAX_FUTURE_MS'>;

const now = Date.parse('2026-11-14T12:00:00.000Z');

function location(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u-123',
    latitude: 41.04,
    longitude: 29.02,
    timestamp: new Date(now).toISOString(),
    ...overrides,
  };
}

describe('parseLocationRequest', () => {
  it('normalizes a single point timestamp into epoch milliseconds', async () => {
    await expect(parseLocationRequest(location(), config, now)).resolves.toEqual({
      points: [{ userId: 'u-123', latitude: 41.04, longitude: 29.02, ts: now }],
      errors: [],
    });
  });

  it('accepts the valid points in a batch and reports only the failing index (partial accept)', async () => {
    const payload = {
      locations: [location(), location({ latitude: 91 })],
    };

    await expect(parseLocationRequest(payload, config, now)).resolves.toEqual({
      points: [{ userId: 'u-123', latitude: 41.04, longitude: 29.02, ts: now }],
      errors: [expect.objectContaining({ index: 1, field: 'latitude' })],
    });
  });

  it('reports invalid coordinates, non-UTC timestamps, and out-of-window timestamps as errors rather than throwing', async () => {
    await expect(
      parseLocationRequest(location({ longitude: -181 }), config, now),
    ).resolves.toMatchObject({
      points: [],
      errors: [expect.objectContaining({ field: 'longitude' })],
    });
    await expect(
      parseLocationRequest(location({ timestamp: '2026-11-14T12:00:00+01:00' }), config, now),
    ).resolves.toMatchObject({
      points: [],
      errors: [expect.objectContaining({ field: 'timestamp' })],
    });
    await expect(
      parseLocationRequest(
        location({ timestamp: new Date(now + config.TS_MAX_FUTURE_MS + 1).toISOString() }),
        config,
        now,
      ),
    ).resolves.toMatchObject({
      points: [],
      errors: [expect.objectContaining({ field: 'timestamp' })],
    });
  });

  it('rejects empty/oversized batches and unsupported fields', async () => {
    await expect(parseLocationRequest({ locations: [] }, config, now)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      parseLocationRequest({ locations: [location(), location(), location()] }, config, now),
    ).rejects.toThrow('MAX_BATCH_LOCATIONS');
    await expect(
      parseLocationRequest({ ...location(), extra: true }, config, now),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

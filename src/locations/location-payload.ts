import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { EnvironmentConfig } from '../config/configuration';
import { LocationDto } from './dto/location.dto';

export type IngestPoint = {
  userId: string;
  latitude: number;
  longitude: number;
  ts: number;
};

export type LocationValidationError = {
  index?: number;
  field: string;
  messages: string[];
};

export type LocationParseResult = {
  points: IngestPoint[];
  errors: LocationValidationError[];
};

export async function parseLocationRequest(
  payload: unknown,
  config: Pick<EnvironmentConfig, 'MAX_BATCH_LOCATIONS' | 'TS_MAX_PAST_MS' | 'TS_MAX_FUTURE_MS'>,
  now = Date.now(),
): Promise<LocationParseResult> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new BadRequestException('Request body must be a location or a locations batch.');
  }

  const body = payload as Record<string, unknown>;
  const isBatch = Object.prototype.hasOwnProperty.call(body, 'locations');
  const allowedFields = isBatch ? ['locations'] : ['userId', 'latitude', 'longitude', 'timestamp'];
  const extraFields = Object.keys(body).filter((key) => !allowedFields.includes(key));
  if (extraFields.length > 0) {
    throw new BadRequestException({
      message: 'Request contains unsupported fields.',
      errors: extraFields.map((field) => ({ field, messages: ['property is not allowed'] })),
    });
  }

  const rawPoints = isBatch ? body.locations : [body];
  if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
    throw new BadRequestException('locations must be a non-empty array.');
  }
  if (rawPoints.length > config.MAX_BATCH_LOCATIONS) {
    throw new BadRequestException(
      `locations exceeds MAX_BATCH_LOCATIONS (${config.MAX_BATCH_LOCATIONS}).`,
    );
  }

  const points: IngestPoint[] = [];
  const errors: LocationValidationError[] = [];

  for (const [index, rawPoint] of rawPoints.entries()) {
    const point = plainToInstance(LocationDto, rawPoint);
    const validationErrors = await validate(point, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });

    if (validationErrors.length > 0) {
      errors.push(...formatValidationErrors(validationErrors, isBatch ? index : undefined));
      continue;
    }

    const ts = Date.parse(point.timestamp);
    if (ts < now - config.TS_MAX_PAST_MS || ts > now + config.TS_MAX_FUTURE_MS) {
      errors.push({
        ...(isBatch ? { index } : {}),
        field: 'timestamp',
        messages: ['timestamp is outside the configured past/future window'],
      });
      continue;
    }

    points.push({
      userId: point.userId,
      latitude: point.latitude,
      longitude: point.longitude,
      ts,
    });
  }

  return { points, errors };
}

function formatValidationErrors(
  validationErrors: ValidationError[],
  index: number | undefined,
): LocationValidationError[] {
  return validationErrors.flatMap((error) => {
    const messages = Object.values(error.constraints ?? {});
    const current =
      messages.length > 0
        ? [{ ...(index === undefined ? {} : { index }), field: error.property, messages }]
        : [];

    return [...current, ...formatValidationErrors(error.children ?? [], index)];
  });
}

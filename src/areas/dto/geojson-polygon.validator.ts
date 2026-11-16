import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

type Position = [number, number];

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

@ValidatorConstraint({ name: 'isGeoJsonPolygon', async: false })
export class GeoJsonPolygonConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const geometry = value as Record<string, unknown>;
    if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
      return false;
    }

    const rings = geometry.coordinates as unknown[];
    if (rings.length === 0) {
      return false;
    }

    return rings.every((ring) => {
      if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) {
        return false;
      }

      const first = ring[0] as Position;
      const last = ring[ring.length - 1] as Position;
      return first[0] === last[0] && first[1] === last[1];
    });
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a closed GeoJSON Polygon with valid coordinate ranges`;
  }
}

export function IsGeoJsonPolygon(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    registerDecorator({
      name: 'isGeoJsonPolygon',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options,
      validator: GeoJsonPolygonConstraint,
    });
  };
}

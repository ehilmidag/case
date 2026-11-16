import { murmur2 } from 'murmurhash-js';

export function partitionForUser(userId: string, partitionCount: number): number {
  if (!Number.isInteger(partitionCount) || partitionCount < 1) {
    throw new RangeError('partitionCount must be a positive integer.');
  }

  return (murmur2(userId) >>> 0) % partitionCount;
}

export function locationStreamKey(partition: number): string {
  return `locations:${partition}`;
}

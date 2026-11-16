import { locationStreamKey, partitionForUser } from './partitioner';

describe('location partitioner', () => {
  it('routes the same user to a stable partition within range', () => {
    const first = partitionForUser('u-123', 16);

    expect(partitionForUser('u-123', 16)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(16);
  });

  it('builds the stream key for the selected partition', () => {
    expect(locationStreamKey(partitionForUser('u-123', 16))).toMatch(/^locations:\d+$/);
  });

  it('rejects invalid partition counts', () => {
    expect(() => partitionForUser('u-123', 0)).toThrow('partitionCount must be a positive integer');
  });
});

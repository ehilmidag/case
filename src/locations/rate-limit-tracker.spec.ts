import { getIpRateLimitKey, getUserRateLimitKey } from './rate-limit-tracker';

describe('location rate limit trackers', () => {
  it('tracks the request IP independently', () => {
    expect(getIpRateLimitKey({ ip: '192.0.2.10' })).toBe('192.0.2.10');
    expect(getIpRateLimitKey({ socket: { remoteAddress: '::1' } })).toBe('::1');
  });

  it('uses a stable sorted key for all distinct user IDs in a batch', () => {
    expect(
      getUserRateLimitKey({
        body: { locations: [{ userId: 'user-b' }, { userId: 'user-a' }] },
      }),
    ).toBe('user-a,user-b');
    expect(getUserRateLimitKey({ body: { userId: 'user-a' } })).toBe('user-a');
  });
});

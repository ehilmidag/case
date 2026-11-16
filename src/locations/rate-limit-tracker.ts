type RateLimitRequest = Record<string, unknown>;

export function getIpRateLimitKey(request: RateLimitRequest): string {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) {
    return ip;
  }

  const socket = request.socket;
  if (typeof socket === 'object' && socket !== null) {
    const address = (socket as Record<string, unknown>).remoteAddress;
    if (typeof address === 'string' && address.length > 0) {
      return address;
    }
  }

  return 'unknown-ip';
}

export function getUserRateLimitKey(request: RateLimitRequest): string {
  return getUserIdsFromRequest(request).join(',') || 'unknown-user';
}

export function getUserIdsFromRequest(request: RateLimitRequest): string[] {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [];
  }

  const payload = body as Record<string, unknown>;
  const userIds = Array.isArray(payload.locations)
    ? payload.locations
        .filter(
          (location): location is Record<string, unknown> =>
            typeof location === 'object' && location !== null && !Array.isArray(location),
        )
        .map((location) => location.userId)
        .filter((userId): userId is string => typeof userId === 'string')
    : typeof payload.userId === 'string'
      ? [payload.userId]
      : [];

  return [...new Set(userIds)].sort();
}

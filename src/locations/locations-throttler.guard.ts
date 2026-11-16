import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { getUserIdsFromRequest } from './rate-limit-tracker';

@Injectable()
export class LocationsThrottlerGuard extends ThrottlerGuard {
  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    if (requestProps.throttler.name !== 'user') {
      return super.handleRequest(requestProps);
    }

    const request = requestProps.context.switchToHttp().getRequest() as Record<string, unknown>;
    const userIds = getUserIdsFromRequest(request);
    if (userIds.length === 0) {
      return super.handleRequest(requestProps);
    }

    for (const userId of userIds) {
      await super.handleRequest({
        ...requestProps,
        getTracker: async () => userId,
      });
    }

    return true;
  }
}

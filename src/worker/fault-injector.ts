import { Injectable } from '@nestjs/common';

export type FaultPoint =
  'before-transaction' | 'during-transaction' | 'after-commit' | 'after-redis-update';

// A no-op hook by default: production code never calls `arm`, so `trigger` always finds
// nothing armed and does nothing. Only Faz 10.2's crash-injection tests call `arm` to make
// a specific (point, messageId) pair throw exactly once, letting those tests reproduce
// each row of the worker's crash table (plan.md Bölüm 7) deterministically.
@Injectable()
export class FaultInjector {
  private readonly armed = new Set<string>();

  arm(point: FaultPoint, messageId: string): void {
    this.armed.add(this.key(point, messageId));
  }

  trigger(point: FaultPoint, messageId: string): void {
    const key = this.key(point, messageId);
    if (this.armed.delete(key)) {
      throw new Error(`Injected fault at ${point} for message ${messageId}`);
    }
  }

  private key(point: FaultPoint, messageId: string): string {
    return `${point}:${messageId}`;
  }
}

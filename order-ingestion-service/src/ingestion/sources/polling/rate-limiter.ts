export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A sliding-window limiter, one per customer, so we stay under the limit THEY set
 * rather than discovering it by being rejected.
 *
 * GlobalGoods allows 60 requests a minute. Our own cadence (a couple of pages every
 * five minutes) is nowhere near that, so in practice this never engages — which is
 * the point. It is a guarantee, not a workaround: a future customer polled harder,
 * or a backfill, would otherwise walk straight into a 429 and only then find out.
 */
export class RateLimiter {
  private readonly grantedAt: number[] = [];

  constructor(private readonly requestsPerMinute: number) {}

  /** Resolves when a request may be made, waiting only if the window is full. */
  async acquire(): Promise<void> {
    const windowMs = 60_000;
    const now = Date.now();

    this.forget(now - windowMs);

    if (this.grantedAt.length >= this.requestsPerMinute) {
      const oldest = this.grantedAt[0];
      const waitMs = oldest + windowMs - now;

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.forget(Date.now() - windowMs);
    }

    this.grantedAt.push(Date.now());
  }

  private forget(before: number): void {
    while (this.grantedAt.length > 0 && this.grantedAt[0] <= before) {
      this.grantedAt.shift();
    }
  }
}

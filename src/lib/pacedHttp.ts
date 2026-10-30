import { HttpService, type IHttpService } from "@kontent-ai/core-sdk";

/**
 * The Management API allows 10 requests per second and 400 per minute per environment, shared by every API
 * key and integration using that environment. This tool stays within half of both, so it never crowds out
 * other work in the environment. (The toolkit's own requests are paced the same way by a patch; see patches/.)
 */
export const requestLimits = { perSecond: 5, perMinute: 200 } as const;

// The windows are a little longer than a second and a minute, so small timing differences between when a
// request is let through and when it reaches the API can't push a window over the limit.
const secondMs = 1100;
const minuteMs = 61_000;

/**
 * One pacer per environment, shared by everything that sends Management API requests in this page: the app's
 * own connections and, through a patch, the migration toolkit (see patches/). Without sharing, a preview
 * followed straight away by a copy could together go over the limits. The registry lives on `globalThis`
 * under a well-known symbol because the patched toolkit can't import the app's modules.
 */
const registryKey = Symbol.for("item-copier.rate-limiters");
type Registry = Map<string, () => Promise<void>>;

export const rateLimiterFor = (environmentId: string): (() => Promise<void>) => {
  const scope = globalThis as unknown as Record<symbol, Registry | undefined>;
  const registry = (scope[registryKey] ??= new Map());
  let limiter = registry.get(environmentId);
  if (!limiter) {
    limiter = createRateLimiter();
    registry.set(environmentId, limiter);
  }
  return limiter;
};

/** Waits until a request may start without going over either limit. Requests get their turn in order. */
export const createRateLimiter = (limits: { readonly perSecond: number; readonly perMinute: number } = requestLimits) => {
  const started: number[] = [];
  let queue: Promise<void> = Promise.resolve();

  const waitMs = (now: number) => {
    while (started.length && now - (started[0] as number) >= minuteMs) started.shift();
    const lastSecond = started.filter((t) => now - t < secondMs);
    if (lastSecond.length >= limits.perSecond) return secondMs - (now - (lastSecond[0] as number));
    if (started.length >= limits.perMinute) return minuteMs - (now - (started[0] as number));
    return 0;
  };

  return (): Promise<void> => {
    const turn = queue.then(async () => {
      for (let wait = waitMs(Date.now()); wait > 0; wait = waitMs(Date.now())) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      started.push(Date.now());
    });
    queue = turn;
    return turn;
  };
};

// The SDK's HTTP service is typed by the cancel token of the HTTP library it uses internally.
type CancelToken = HttpService extends IHttpService<infer T> ? T : never;

/**
 * An HTTP service for the Management SDK that starts requests no faster than `requestLimits`. It delegates to
 * the SDK's own service, so the SDK's retries still apply: a request that hits the rate limit anyway (for
 * example because of other traffic in the environment) is retried with back-off.
 * The pacing is shared per environment (see `rateLimiterFor`).
 */
export const createPacedHttpService = (environmentId: string): IHttpService<CancelToken> => {
  const inner = new HttpService();
  const waitForTurn = rateLimiterFor(environmentId);

  const paced =
    <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>) =>
    async (...args: TArgs): Promise<TResult> => {
      await waitForTurn();
      return fn(...args);
    };

  return {
    getAsync: paced((call, options) => inner.getAsync(call, options)),
    postAsync: paced((call, options) => inner.postAsync(call, options)),
    putAsync: paced((call, options) => inner.putAsync(call, options)),
    patchAsync: paced((call, options) => inner.patchAsync(call, options)),
    deleteAsync: paced((call, options) => inner.deleteAsync(call, options)),
    createCancelToken: () => inner.createCancelToken(),
  };
};

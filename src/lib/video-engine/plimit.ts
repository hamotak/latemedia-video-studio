/**
 * Tiny in-memory concurrency limiter with zero dependencies.
 *
 * Usage:
 *   const limit = pLimit(5);
 *   await Promise.all(items.map(item => limit(() => processItem(item))));
 */
export interface LimitFunction {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly concurrency: number;
}

export function pLimit(concurrency: number): LimitFunction {
  if (concurrency < 1) concurrency = 1;
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const task = queue.shift()!;
    task();
  };

  const limit = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  Object.defineProperties(limit, {
    activeCount: { get: () => active },
    pendingCount: { get: () => queue.length },
    concurrency: { get: () => concurrency },
  });
  return limit as LimitFunction;
}

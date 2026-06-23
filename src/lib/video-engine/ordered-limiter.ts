import type { LimitFunction } from "./plimit";

export async function runOrderedLimited<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  limit?: LimitFunction
): Promise<R[]> {
  return Promise.all(
    items.map((item, index) => {
      const task = () => worker(item, index);
      return limit ? limit(task) : task();
    })
  );
}

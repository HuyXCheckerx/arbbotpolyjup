export interface CoalescingAsyncQueueOptions<T> {
  capacity: number;
  coalesceKey?: (item: T) => string | null;
}

interface PendingItem<T> {
  item: T;
  key: string | null;
}

/**
 * A bounded single-consumer queue that can replace obsolete pending updates.
 * Status and control events retain their order while high-frequency market
 * snapshots with the same key collapse to the newest available value.
 */
export class CoalescingAsyncQueue<T> {
  readonly #capacity: number;
  readonly #coalesceKey: (item: T) => string | null;
  readonly #items: PendingItem<T>[] = [];
  readonly #waiters: Array<(item: T) => void> = [];

  constructor(options: CoalescingAsyncQueueOptions<T>) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Async queue capacity must be a positive integer");
    }
    this.#capacity = options.capacity;
    this.#coalesceKey = options.coalesceKey ?? (() => null);
  }

  get pendingCount(): number {
    return this.#items.length;
  }

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }

    const key = this.#coalesceKey(item);
    if (key !== null) {
      const existing = this.#items.findIndex((pending) => pending.key === key);
      if (existing >= 0) {
        this.#items[existing] = { item, key };
        return;
      }
    }

    if (this.#items.length >= this.#capacity) {
      const obsoleteSnapshot = this.#items.findIndex((pending) => pending.key !== null);
      this.#items.splice(obsoleteSnapshot >= 0 ? obsoleteSnapshot : 0, 1);
    }
    this.#items.push({ item, key });
  }

  async next(): Promise<T> {
    const pending = this.#items.shift();
    if (pending) return pending.item;
    return await new Promise<T>((resolveNext) => this.#waiters.push(resolveNext));
  }
}

export type JupiterRequestPriority = "critical" | "normal";

/** Serializes Jupiter's main API-key bucket across Prediction and Swap clients. */
export class JupiterRequestScheduler {
  readonly #minimumIntervalMs: number;
  #lastRequestAtMs = 0;
  readonly #criticalQueue: Array<() => void> = [];
  readonly #normalQueue: Array<() => void> = [];
  #draining = false;

  constructor(minimumIntervalMs: number) {
    if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("Jupiter request interval must be a non-negative integer");
    }
    this.#minimumIntervalMs = minimumIntervalMs;
  }

  async wait(priority: JupiterRequestPriority = "normal"): Promise<void> {
    await new Promise<void>((resolve) => {
      const queue = priority === "critical" ? this.#criticalQueue : this.#normalQueue;
      queue.push(resolve);
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#criticalQueue.length > 0 || this.#normalQueue.length > 0) {
        const release = this.#criticalQueue.shift() ?? this.#normalQueue.shift();
        if (!release) break;
      const waitMs = Math.max(0, this.#lastRequestAtMs + this.#minimumIntervalMs - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.#lastRequestAtMs = Date.now();
        release();
      }
    } finally {
      this.#draining = false;
    }
  }
}

/** Serializes Jupiter's main API-key bucket across Prediction and Swap clients. */
export class JupiterRequestScheduler {
  readonly #minimumIntervalMs: number;
  #lastRequestAtMs = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(minimumIntervalMs: number) {
    if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("Jupiter request interval must be a non-negative integer");
    }
    this.#minimumIntervalMs = minimumIntervalMs;
  }

  async wait(): Promise<void> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.#lastRequestAtMs + this.#minimumIntervalMs - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.#lastRequestAtMs = Date.now();
    } finally {
      release();
    }
  }
}

export class CliArgs {
  readonly #values = new Map<string, string>();
  readonly #flags = new Set<string>();

  constructor(argv: readonly string[]) {
    for (const item of argv) {
      if (!item.startsWith("--")) continue;
      const separator = item.indexOf("=");
      if (separator === -1) {
        this.#flags.add(item.slice(2));
      } else {
        this.#values.set(item.slice(2, separator), item.slice(separator + 1));
      }
    }
  }

  has(name: string): boolean {
    return this.#flags.has(name) || this.#values.has(name);
  }

  string(name: string, fallback: string): string {
    return this.#values.get(name) ?? fallback;
  }

  required(name: string): string {
    const value = this.#values.get(name);
    if (!value) throw new Error(`Missing required argument --${name}=...`);
    return value;
  }

  integer(name: string, fallback: number): number {
    const raw = this.#values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`--${name} must be a non-negative integer`);
    }
    return value;
  }

  csv(name: string, fallback: readonly string[]): string[] {
    const raw = this.#values.get(name);
    if (raw === undefined) return [...fallback];
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

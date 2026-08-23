export interface HttpClientOptions {
  timeoutMs?: number;
  retries?: number;
  defaultHeaders?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

export function parseRateLimitResetTimestampMs(
  headers?: Headers | Readonly<Record<string, string>> | null,
): number | null {
  if (!headers) return null;
  let resetVal: string | null | undefined;
  if (typeof (headers as Headers).get === "function") {
    resetVal = (headers as Headers).get("x-ratelimit-reset");
  } else {
    const record = headers as Record<string, string>;
    resetVal = record["x-ratelimit-reset"] ?? record["X-RateLimit-Reset"];
  }
  if (!resetVal) return null;
  const resetSeconds = Number(resetVal);
  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) return null;
  return Math.round(resetSeconds * 1000);
}

export function parseRateLimitDelayMs(
  headers?: Headers | Readonly<Record<string, string>> | null,
  nowMs: number = Date.now(),
): number | null {
  const resetTimestampMs = parseRateLimitResetTimestampMs(headers);
  if (resetTimestampMs !== null) {
    return Math.max(0, resetTimestampMs - nowMs);
  }
  if (!headers) return null;
  let retryAfterVal: string | null | undefined;
  if (typeof (headers as Headers).get === "function") {
    retryAfterVal = (headers as Headers).get("retry-after");
  } else {
    const record = headers as Record<string, string>;
    retryAfterVal = record["retry-after"] ?? record["Retry-After"];
  }
  if (!retryAfterVal) return null;
  const seconds = Number(retryAfterVal);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const parsedDate = Date.parse(retryAfterVal);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }
  return null;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly headers?: Headers | Readonly<Record<string, string>> | undefined;
  readonly rateLimitResetMs: number | null;
  readonly retryDelayMs: number | null;

  constructor(
    url: string,
    status: number,
    body: string,
    headers?: Headers | Readonly<Record<string, string>>,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.headers = headers;
    this.rateLimitResetMs = parseRateLimitResetTimestampMs(headers);
    this.retryDelayMs = parseRateLimitDelayMs(headers);
  }
}

export class HttpClient {
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #defaultHeaders: Readonly<Record<string, string>>;
  readonly #fetch: typeof fetch;

  constructor(options: HttpClientOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#retries = options.retries ?? 2;
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async getJson(url: URL | string, headers: Readonly<Record<string, string>> = {}): Promise<unknown> {
    return await this.requestJson(url, { method: "GET", headers });
  }

  async postJson(
    url: URL | string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return await this.requestJson(url, { method: "POST", headers, body });
  }

  async deleteJson(
    url: URL | string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return await this.requestJson(url, { method: "DELETE", headers, body });
  }

  async requestJson(
    url: URL | string,
    options: {
      method: "GET" | "POST" | "DELETE";
      headers?: Readonly<Record<string, string>>;
      body?: unknown;
    },
  ): Promise<unknown> {
    const target = String(url);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      try {
        const init: RequestInit = {
          method: options.method,
          headers: {
            ...this.#defaultHeaders,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            ...options.headers,
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        };
        if (options.body !== undefined) init.body = JSON.stringify(options.body);
        const response = await this.#fetch(target, init);
        const body = await response.text();
        if (!response.ok) {
          const error = new HttpError(target, response.status, body, response.headers);
          if (!isRetryableStatus(response.status) || attempt === this.#retries) {
            throw error;
          }
          lastError = error;
        } else {
          try {
            return JSON.parse(body) as unknown;
          } catch (error) {
            throw new Error(`Invalid JSON from ${target}: ${String(error)}`);
          }
        }
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError && !isRetryableStatus(error.status)) {
          throw error;
        }
        if (attempt === this.#retries) {
          throw error;
        }
      }

      const delayMs = lastError instanceof HttpError && lastError.status === 429 && lastError.retryDelayMs !== null && lastError.retryDelayMs !== undefined
        ? Math.min(60_000, lastError.retryDelayMs + 50)
        : 200 * 2 ** attempt;

      await sleep(delayMs);
    }

    throw lastError instanceof Error ? lastError : new Error(`Request failed for ${target}`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

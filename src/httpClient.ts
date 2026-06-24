/**
 * Thin HTTP layer around axios.
 *
 * Responsibilities:
 *  - keep a browser-like User-Agent (the sites 403 the default axios UA);
 *  - persist cookies (mainly JSESSIONID) across requests by hand, so we do not
 *    need an extra cookie-jar dependency;
 *  - centralise retry-with-exponential-backoff, including first-class handling
 *    of HTTP 429 (Too Many Requests) with respect for the `Retry-After` header.
 */
import axios, { AxiosInstance, AxiosResponse, AxiosRequestConfig } from "axios";
import { USER_AGENT } from "./config";
import { Logger } from "./logger";

/** Sleep helper. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Thrown when all retries are exhausted. */
export class RequestFailedError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly attempts?: number,
  ) {
    super(message);
    this.name = "RequestFailedError";
  }
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly cookies = new Map<string, string>();
  private readonly log: Logger;
  private readonly retry: RetryOptions;

  constructor(opts: {
    timeoutMs: number;
    retry: RetryOptions;
    logger: Logger;
  }) {
    this.log = opts.logger.child("[http]");
    this.retry = opts.retry;
    this.axios = axios.create({
      timeout: opts.timeoutMs,
      maxRedirects: 5,
      // Accept any status so we can inspect 429/5xx ourselves instead of
      // axios throwing before our retry logic runs.
      validateStatus: () => true,
      // Keep PDFs intact: default to arraybuffer for binary, text for HTML.
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
      },
      // Large PDFs (10MB+) must not be truncated.
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  }

  /** Current cookie header value, or undefined if no cookies yet. */
  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  /** Store cookies from a response's set-cookie header(s). */
  private storeCookies(res: AxiosResponse): void {
    const setCookie = res.headers["set-cookie"];
    if (!setCookie) return;
    for (const raw of setCookie) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      this.cookies.set(name, value);
    }
  }

  /**
   * Parse `Retry-After` (delta-seconds or HTTP-date) into ms, or undefined.
   */
  private parseRetryAfter(res?: AxiosResponse): number | undefined {
    const header = res?.headers?.["retry-after"];
    if (!header) return undefined;
    const asInt = Number(header);
    if (Number.isFinite(asInt)) return asInt * 1000;
    const date = Date.parse(String(header));
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return undefined;
  }

  /**
   * Decide whether a status code is worth retrying.
   * 429 = rate limited; 408 = timeout; 5xx = transient server errors.
   */
  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 408 || (status >= 500 && status <= 599);
  }

  /**
   * Compute the backoff delay for a given attempt using exponential growth
   * plus full jitter, capped at backoffMaxMs. A server-provided Retry-After
   * always wins.
   */
  private backoffDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.retry.backoffMaxMs);
    }
    const exp = this.retry.backoffBaseMs * Math.pow(2, attempt);
    const capped = Math.min(exp, this.retry.backoffMaxMs);
    // Full jitter: random in [capped/2, capped] to avoid thundering herd.
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  /**
   * Core request driver with retry/backoff. `label` is used purely for logs.
   */
  async request<T = unknown>(
    config: AxiosRequestConfig,
    label: string,
  ): Promise<AxiosResponse<T>> {
    const headers: Record<string, string> = { ...(config.headers as any) };
    const cookie = this.cookieHeader();
    if (cookie) headers["Cookie"] = cookie;

    let lastStatus: number | undefined;
    let lastError: unknown;

    // attempt 0 = first try; up to maxRetries additional attempts.
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      // Refresh cookie header each attempt (it may have been set meanwhile).
      const freshCookie = this.cookieHeader();
      if (freshCookie) headers["Cookie"] = freshCookie;

      try {
        const res = await this.axios.request<T>({ ...config, headers });
        this.storeCookies(res);
        lastStatus = res.status;

        if (this.isRetryableStatus(res.status)) {
          if (attempt === this.retry.maxRetries) {
            throw new RequestFailedError(
              `${label}: giving up after ${attempt + 1} attempts (HTTP ${res.status})`,
              res.status,
              attempt + 1,
            );
          }
          const retryAfter = this.parseRetryAfter(res);
          const delay = this.backoffDelay(attempt, retryAfter);
          const reason =
            res.status === 429 ? "rate limited (429)" : `HTTP ${res.status}`;
          this.log.warn(
            `${label}: ${reason}; backing off ${delay}ms ` +
              `(attempt ${attempt + 1}/${this.retry.maxRetries + 1})` +
              (retryAfter !== undefined ? ` [Retry-After honored]` : ""),
          );
          await sleep(delay);
          continue;
        }

        // Non-retryable status: return as-is (caller validates 2xx).
        return res;
      } catch (err) {
        // RequestFailedError from the giving-up branch above: rethrow.
        if (err instanceof RequestFailedError) throw err;

        lastError = err;
        const isNetwork = axios.isAxiosError(err);
        if (attempt === this.retry.maxRetries) {
          throw new RequestFailedError(
            `${label}: network error after ${attempt + 1} attempts: ` +
              (isNetwork ? (err as Error).message : String(err)),
            lastStatus,
            attempt + 1,
          );
        }
        const delay = this.backoffDelay(attempt);
        this.log.warn(
          `${label}: request error (${
            isNetwork ? (err as Error).message : String(err)
          }); backing off ${delay}ms ` +
            `(attempt ${attempt + 1}/${this.retry.maxRetries + 1})`,
        );
        await sleep(delay);
      }
    }

    // Unreachable, but satisfies the type checker.
    throw new RequestFailedError(
      `${label}: exhausted retries`,
      lastStatus,
      this.retry.maxRetries + 1,
    );
  }

  /** GET returning HTML/text. */
  async getText(url: string, label: string): Promise<AxiosResponse<string>> {
    return this.request<string>(
      { method: "GET", url, responseType: "text" },
      label,
    );
  }

  /** POST a urlencoded body returning text (used for JSF AJAX postbacks). */
  async postFormText(
    url: string,
    body: string,
    extraHeaders: Record<string, string>,
    label: string,
  ): Promise<AxiosResponse<string>> {
    return this.request<string>(
      {
        method: "POST",
        url,
        data: body,
        responseType: "text",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          ...extraHeaders,
        },
      },
      label,
    );
  }

  /** POST a urlencoded body returning binary (used for PDF downloads). */
  async postFormBinary(
    url: string,
    body: string,
    label: string,
  ): Promise<AxiosResponse<Buffer>> {
    return this.request<Buffer>(
      {
        method: "POST",
        url,
        data: body,
        responseType: "arraybuffer",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
      },
      label,
    );
  }
}

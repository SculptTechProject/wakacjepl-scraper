import type { HttpMethod } from "./types";

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;

  constructor(
    readonly method: HttpMethod,
    readonly url: string,
    response: Response,
    readonly body: unknown,
  ) {
    // Avoid putting response bodies, cookies, or query values in log messages.
    super(`HTTP ${response.status} for ${method} request`);
    this.status = response.status;
    this.statusText = response.statusText;
    this.headers = new Headers(response.headers);
  }
}

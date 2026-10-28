import { HttpError } from "./HttpError";
import type { CookieJar } from "tough-cookie";
import type {
  HttpClientOptions,
  HttpMethod,
  HttpResponse,
  JsonRequestOptions,
  JsonValue,
  QueryParameters,
  TextRequestOptions,
} from "./types";

type ResponseOptions = JsonRequestOptions | TextRequestOptions;

export class HttpClient {
  private readonly baseUrl: URL;
  private readonly headers: Headers;
  private readonly timeout: number;
  private readonly cookieJar: CookieJar | undefined;

  constructor({
    baseUrl,
    headers,
    timeout = 10_000,
    cookieJar,
  }: HttpClientOptions) {
    this.baseUrl = new URL(baseUrl);
    this.validateUrl(this.baseUrl);
    if (!this.baseUrl.pathname.endsWith("/")) {
      this.baseUrl.pathname += "/";
    }

    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
      throw new RangeError("timeout must be an integer between 1 and 2147483647 ms");
    }

    this.headers = new Headers(headers);
    this.timeout = timeout;
    this.cookieJar = cookieJar;
  }

  get<T = unknown>(
    path: string,
    options?: JsonRequestOptions,
  ): Promise<HttpResponse<T>>;
  get(path: string, options: TextRequestOptions): Promise<HttpResponse<string>>;
  get<T = unknown>(
    path: string,
    options: ResponseOptions = {},
  ): Promise<HttpResponse<T | string>> {
    return this.request<T | string>("GET", path, options);
  }

  post<T = unknown>(
    path: string,
    body?: JsonValue,
    options?: JsonRequestOptions,
  ): Promise<HttpResponse<T>>;
  post(
    path: string,
    body: JsonValue | undefined,
    options: TextRequestOptions,
  ): Promise<HttpResponse<string>>;
  post<T = unknown>(
    path: string,
    body?: JsonValue,
    options: ResponseOptions = {},
  ): Promise<HttpResponse<T | string>> {
    return this.request<T | string>("POST", path, options, body);
  }

  put<T = unknown>(
    path: string,
    body?: JsonValue,
    options?: JsonRequestOptions,
  ): Promise<HttpResponse<T>>;
  put(
    path: string,
    body: JsonValue | undefined,
    options: TextRequestOptions,
  ): Promise<HttpResponse<string>>;
  put<T = unknown>(
    path: string,
    body?: JsonValue,
    options: ResponseOptions = {},
  ): Promise<HttpResponse<T | string>> {
    return this.request<T | string>("PUT", path, options, body);
  }

  patch<T = unknown>(
    path: string,
    body?: JsonValue,
    options?: JsonRequestOptions,
  ): Promise<HttpResponse<T>>;
  patch(
    path: string,
    body: JsonValue | undefined,
    options: TextRequestOptions,
  ): Promise<HttpResponse<string>>;
  patch<T = unknown>(
    path: string,
    body?: JsonValue,
    options: ResponseOptions = {},
  ): Promise<HttpResponse<T | string>> {
    return this.request<T | string>("PATCH", path, options, body);
  }

  delete<T = unknown>(
    path: string,
    options?: JsonRequestOptions,
  ): Promise<HttpResponse<T>>;
  delete(path: string, options: TextRequestOptions): Promise<HttpResponse<string>>;
  delete<T = unknown>(
    path: string,
    options: ResponseOptions = {},
  ): Promise<HttpResponse<T | string>> {
    return this.request<T | string>("DELETE", path, options);
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    options: ResponseOptions,
    body?: JsonValue,
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const headers = new Headers(this.headers);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));

    if (this.cookieJar && !headers.has("Cookie")) {
      const cookies = await this.cookieJar.getCookieString(url.href);
      if (cookies) headers.set("Cookie", cookies);
    }

    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (serializedBody !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const timeoutSignal = AbortSignal.timeout(this.timeout);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const response = await fetch(url, {
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
      signal,
      redirect: "manual",
    });

    if (this.cookieJar) {
      for (const cookie of response.headers.getSetCookie()) {
        await this.cookieJar.setCookie(cookie, url.href, { ignoreError: true });
      }
    }

    const text = await response.text();

    if (!response.ok) {
      throw new HttpError(method, url.href, response, this.parseErrorBody(text));
    }

    const data = text === ""
      ? undefined
      : options.responseType === "text"
        ? text
        : this.parseJson(text);

    return {
      data: data as T | undefined,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: response.url || url.href,
    };
  }

  private buildUrl(path: string, query?: QueryParameters): URL {
    const url = new URL(path, this.baseUrl);
    this.validateUrl(url);
    if (url.origin !== this.baseUrl.origin) {
      throw new TypeError("Request URL must use the configured base origin");
    }

    if (query instanceof URLSearchParams) {
      for (const key of new Set(query.keys())) {
        url.searchParams.delete(key);
      }
      query.forEach((value, key) => url.searchParams.append(key, value));
    } else if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url;
  }

  private validateUrl(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("URL must use HTTP or HTTPS");
    }
    if (url.username || url.password) {
      throw new TypeError("URL must not contain embedded credentials");
    }
  }

  private parseJson(text: string): unknown {
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch (cause) {
      throw new SyntaxError("Invalid JSON response", { cause });
    }
  }

  private parseErrorBody(text: string): unknown {
    if (text === "") return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch {
      return text;
    }
  }
}

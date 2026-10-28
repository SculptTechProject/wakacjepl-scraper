import type { HeadersInit } from "bun";
import type { CookieJar } from "tough-cookie";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpClientOptions {
  readonly baseUrl: string;
  /** Timeout in milliseconds, including reading the response body. */
  readonly timeout?: number;
  readonly headers?: HeadersInit;
  /** Optional shared cookie storage. No jar is created automatically. */
  readonly cookieJar?: CookieJar;
}

export type QueryParameters =
  | URLSearchParams
  | Readonly<Record<string, string | number | boolean | null | undefined>>;

interface RequestOptions {
  readonly query?: QueryParameters;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
}

export interface JsonRequestOptions extends RequestOptions {
  readonly responseType?: "json";
}

export interface TextRequestOptions extends RequestOptions {
  readonly responseType: "text";
}

export interface HttpResponse<T> {
  readonly data: T | undefined;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
}

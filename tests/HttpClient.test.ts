import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { HttpClient } from "../src/http/HttpClient";
import { HttpError } from "../src/http/HttpError";

afterEach(() => {
  mock.restore();
});

function mockFetchImplementation(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) {
  // Bun's fetch type includes this static method as well as its call signature.
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

function mockFetchUntilAborted() {
  return mockFetchImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;

        if (!signal) {
          reject(new Error("Expected the client to supply an abort signal"));
          return;
        }

        if (signal.aborted) {
          reject(signal.reason);
          return;
        }

        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
}

describe("HttpClient", () => {
  test("returns JSON and HTTP response metadata for a successful GET", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"offers":[{"id":42}]}', {
        status: 200,
        statusText: "OK",
        headers: { "x-request-id": "request-1" },
      }),
    );
    const client = new HttpClient({ baseUrl: "https://example.test/api" });

    const response = await client.get<{ offers: { id: number }[] }>("offers");

    expect(response.data).toEqual({ offers: [{ id: 42 }] });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.url).toBe("https://example.test/api/offers");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  test("throws HttpError with parsed error details and does not retry", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { message: "Service unavailable" },
        {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "retry-after": "60" },
        },
      ),
    );
    const client = new HttpClient({ baseUrl: "https://example.test/api/" });

    const error: unknown = await client
      .get("offers")
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HttpError);
    if (!(error instanceof HttpError)) {
      throw new Error("Expected an HTTP error");
    }
    expect(error.status).toBe(503);
    expect(error.statusText).toBe("Service Unavailable");
    expect(error.headers.get("retry-after")).toBe("60");
    expect(error.body).toEqual({ message: "Service unavailable" });
    expect(error.method).toBe("GET");
    expect(error.url).toBe("https://example.test/api/offers");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("preserves an HTTP error when its body is not valid JSON", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await expect(client.get("/")).rejects.toMatchObject({
      status: 502,
      body: "<html>Bad gateway</html>",
    });
  });

  test("leaves transport errors distinguishable from HTTP errors", async () => {
    const transportError = new TypeError("Connection refused");
    const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(transportError);
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await expect(client.get("/")).rejects.toBe(transportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("aborts a timed out request with the native TimeoutError", async () => {
    const fetchMock = mockFetchUntilAborted();
    const client = new HttpClient({
      baseUrl: "https://example.test",
      timeout: 10,
    });

    await expect(client.get("/")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps the timeout active while reading the response body", async () => {
    mockFetchImplementation(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Expected the client to supply an abort signal");
      }

      // Simulate response headers arriving before a body that never finishes.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (signal.aborted) {
            controller.error(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(body);
    });
    const client = new HttpClient({
      baseUrl: "https://example.test",
      timeout: 10,
    });

    await expect(client.get("/")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  test("preserves the caller's cancellation reason", async () => {
    mockFetchUntilAborted();
    const client = new HttpClient({ baseUrl: "https://example.test" });
    const controller = new AbortController();
    const reason = new Error("Caller cancelled the request");
    const response = client.get("/", { signal: controller.signal });

    controller.abort(reason);

    await expect(response).rejects.toBe(reason);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid timeout %s before making a request",
    (timeout) => {
      const fetchMock = spyOn(globalThis, "fetch");

      expect(
        () => new HttpClient({ baseUrl: "https://example.test", timeout }),
      ).toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("encodes query parameters, replaces existing values, and ignores absent values", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({}),
    );
    const client = new HttpClient({ baseUrl: "https://example.test/api/" });

    await client.get("offers?page=1&keep=yes", {
      query: {
        page: 2,
        search: "sea & sun",
        available: true,
        ignoredNull: null,
        ignoredUndefined: undefined,
      },
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/offers");
    expect(url.searchParams.getAll("page")).toEqual(["2"]);
    expect(url.searchParams.get("keep")).toBe("yes");
    expect(url.searchParams.get("search")).toBe("sea & sun");
    expect(url.searchParams.get("available")).toBe("true");
    expect(url.searchParams.has("ignoredNull")).toBe(false);
    expect(url.searchParams.has("ignoredUndefined")).toBe(false);
  });

  test("retains repeated query values supplied through URLSearchParams", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({}),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await client.get("/offers?region=old&keep=yes", {
      query: new URLSearchParams([
        ["region", "Greece"],
        ["region", "Spain"],
      ]),
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.getAll("region")).toEqual(["Greece", "Spain"]);
    expect(url.searchParams.get("keep")).toBe("yes");
  });

  test("overrides default headers case-insensitively without mutating later requests", async () => {
    const fetchMock = mockFetchImplementation(async () =>
      Response.json({}),
    );
    const defaultHeaders = new Headers({
      "x-client": "default",
      "x-retained": "retained",
    });
    const client = new HttpClient({
      baseUrl: "https://example.test",
      headers: defaultHeaders,
    });

    await client.get("/", {
      headers: { "X-Client": "custom", "x-request": "specific" },
    });
    await client.get("/");

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("x-client")).toBe("custom");
    expect(firstHeaders.get("x-retained")).toBe("retained");
    expect(firstHeaders.get("x-request")).toBe("specific");
    expect(secondHeaders.get("x-client")).toBe("default");
    expect(secondHeaders.has("x-request")).toBe(false);
    expect(defaultHeaders.get("x-client")).toBe("default");
  });

  test.each([204, 205, 200])(
    "returns undefined for an empty successful response with status %s",
    async (status) => {
      spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status }),
      );
      const client = new HttpClient({ baseUrl: "https://example.test" });

      const response = await client.get("/");

      expect(response.data).toBeUndefined();
      expect(response.status).toBe(status);
    },
  );

  test("preserves a JSON null response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("null"));
    const client = new HttpClient({ baseUrl: "https://example.test" });

    expect((await client.get<null>("/")).data).toBeNull();
  });

  test("returns explicitly requested text without parsing it as JSON", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>Public page</html>"),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    const response = await client.get("/", { responseType: "text" });
    const text: string | undefined = response.data;

    expect(text).toBe("<html>Public page</html>");
  });

  test.each(["post", "put", "patch"] as const)(
    "%s serializes JSON exactly once and sends the correct method",
    async (method) => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      );
      const client = new HttpClient({ baseUrl: "https://example.test" });
      const body = { name: "Offer", enabled: true, tags: ["sea"], price: null };

      await client[method]("/offers", body);

      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.method).toBe(method.toUpperCase());
      expect(init?.body).toBe(JSON.stringify(body));
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("serializes a JSON null body and preserves an explicit content type", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await client.post("/offers", null, {
      headers: { "Content-Type": "application/merge-patch+json" },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe("null");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/merge-patch+json",
    );
  });

  test("does not add a JSON body or content type to a POST without a body", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await client.post("/offers");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  test("sends a DELETE request without a body", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await client.delete("/offers/42");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reports invalid JSON from a successful response as a parsing error", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"unfinished":'),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await expect(client.get("/")).rejects.toBeInstanceOf(SyntaxError);
  });

  test.each([
    ["https://example.test/api", "offers", "https://example.test/api/offers"],
    ["https://example.test/api/", "offers", "https://example.test/api/offers"],
    ["https://example.test/api", "/offers", "https://example.test/offers"],
    [
      "https://example.test/api",
      "https://example.test/offers",
      "https://example.test/offers",
    ],
  ] satisfies [string, string, string][])("resolves %s and %s as %s", async (baseUrl, path, expectedUrl) => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({}),
    );
    const client = new HttpClient({ baseUrl });

    await client.get(path);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(expectedUrl);
  });

  test.each([
    "https://another.test/offers",
    "//another.test/offers",
    "https://username:password@example.test/offers",
    "file:///tmp/offers.json",
  ])("rejects unsafe request URL %s before fetch", async (path) => {
    const fetchMock = spyOn(globalThis, "fetch");
    const client = new HttpClient({ baseUrl: "https://example.test/api" });

    await expect(client.get(path)).rejects.toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces redirects as HTTP errors instead of forwarding request headers", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://another.test/offers" },
      }),
    );
    const client = new HttpClient({ baseUrl: "https://example.test" });

    await expect(client.get("/offers")).rejects.toMatchObject({ status: 302 });
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CookieJar } from "tough-cookie";
import { HttpClient } from "../src/http/HttpClient";
import { HttpError } from "../src/http/HttpError";

afterEach(() => {
  mock.restore();
});

function cookieResponse(...cookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
}

function mockResponses(...responses: Response[]) {
  let nextResponse = 0;
  const implementation = async () => {
    const response = responses[nextResponse++];
    if (!response) throw new Error("Unexpected request in cookie test");
    return response;
  };
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

describe("HttpClient cookie jar", () => {
  test("stores multiple Set-Cookie headers and sends cookies on later requests", async () => {
    const fetchMock = mockResponses(
      cookieResponse(
        "session=example; Path=/; HttpOnly; Secure",
        "preference=sea; Path=/; Expires=Wed, 01 Jan 2100 00:00:00 GMT",
      ),
      cookieResponse(),
    );
    const cookieJar = new CookieJar();
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar });

    await client.get("/init");
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Cookie")).toBe(false);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe(
      "session=example; preference=sea",
    );
  });

  test("uses cookie path boundaries and sends the most specific path first", async () => {
    const fetchMock = mockResponses(
      cookieResponse("global=one; Path=/", "offer=two; Path=/offers"),
      cookieResponse(),
      cookieResponse(),
      cookieResponse(),
    );
    const client = new HttpClient({
      baseUrl: "https://example.com",
      cookieJar: new CookieJar(),
    });

    await client.get("/init");
    await client.get("/offers/42");
    await client.get("/offership");
    await client.get("/other");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe(
      "offer=two; global=one",
    );
    for (const call of fetchMock.mock.calls.slice(2)) {
      expect(new Headers(call[1]?.headers).get("Cookie")).toBe("global=one");
    }
  });

  test("limits host cookies to their host while sharing domain cookies with subdomains", async () => {
    const fetchMock = mockResponses(
      cookieResponse("host=one; Path=/", "domain=two; Domain=example.com; Path=/"),
      cookieResponse(),
      cookieResponse(),
    );
    const cookieJar = new CookieJar();
    const initial = new HttpClient({ baseUrl: "https://travel.example.com", cookieJar });
    const sibling = new HttpClient({ baseUrl: "https://api.example.com", cookieJar });
    const unrelated = new HttpClient({ baseUrl: "https://unrelated.com", cookieJar });

    await initial.get("/");
    await sibling.get("/");
    await unrelated.get("/");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("domain=two");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).has("Cookie")).toBe(false);
  });

  test("sends Secure cookies only over HTTPS", async () => {
    const fetchMock = mockResponses(
      cookieResponse("secure=one; Secure; Path=/", "ordinary=two; Path=/"),
      cookieResponse(),
      cookieResponse(),
    );
    const cookieJar = new CookieJar();
    const secure = new HttpClient({ baseUrl: "https://example.com", cookieJar });
    const insecure = new HttpClient({ baseUrl: "http://example.com", cookieJar });

    await secure.get("/init");
    await insecure.get("/");
    await secure.get("/");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("ordinary=two");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("Cookie")).toBe(
      "secure=one; ordinary=two",
    );
  });

  test("omits expired cookies and honors server deletion with Max-Age=0", async () => {
    const fetchMock = mockResponses(
      cookieResponse(
        "expired=one; Path=/; Expires=Wed, 01 Jan 2000 00:00:00 GMT",
        "session=two; Path=/; Max-Age=60",
      ),
      cookieResponse("session=deleted; Path=/; Max-Age=0"),
      cookieResponse(),
    );
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar: new CookieJar() });

    await client.get("/init");
    await client.get("/logout");
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("session=two");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).has("Cookie")).toBe(false);
  });

  test("captures cookies before throwing an HTTP error", async () => {
    const fetchMock = mockResponses(
      new Response("Unavailable", {
        status: 503,
        headers: { "Set-Cookie": "session=one; Path=/" },
      }),
      cookieResponse(),
    );
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar: new CookieJar() });

    await expect(client.get("/init")).rejects.toBeInstanceOf(HttpError);
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("session=one");
  });

  test("captures cookies before parsing an invalid JSON response", async () => {
    const fetchMock = mockResponses(
      new Response("invalid JSON", { headers: { "Set-Cookie": "session=one; Path=/" } }),
      cookieResponse(),
    );
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar: new CookieJar() });

    await expect(client.get("/init")).rejects.toBeInstanceOf(SyntaxError);
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("session=one");
  });

  test("captures redirect cookies without following the redirect", async () => {
    const fetchMock = mockResponses(
      new Response(null, {
        status: 302,
        headers: { "Set-Cookie": "session=one; Path=/", Location: "https://unrelated.com" },
      }),
      cookieResponse(),
    );
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar: new CookieJar() });

    await expect(client.get("/init")).rejects.toMatchObject({ status: 302 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("session=one");
  });

  test("preserves explicit Cookie headers, including an intentionally empty header", async () => {
    const fetchMock = mockResponses(cookieResponse(), cookieResponse(), cookieResponse());
    const cookieJar = new CookieJar();
    await cookieJar.setCookie("jar=value; Path=/", "https://example.com");
    const client = new HttpClient({
      baseUrl: "https://example.com",
      cookieJar,
      headers: { Cookie: "default=value" },
    });

    await client.get("/");
    await client.get("/", { headers: { cookie: "explicit=value" } });
    await client.get("/", { headers: { Cookie: "" } });

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Cookie")).toBe("default=value");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("explicit=value");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("Cookie")).toBe("");
  });

  test("does not retain cookies when no jar was configured", async () => {
    const fetchMock = mockResponses(cookieResponse("session=one; Path=/"), cookieResponse());
    const client = new HttpClient({ baseUrl: "https://example.com" });

    await client.get("/init");
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("Cookie")).toBe(false);
  });

  test("ignores malformed, unrelated-domain, and public-suffix cookies", async () => {
    const fetchMock = mockResponses(
      cookieResponse(
        "invalid-cookie",
        "unrelated=one; Domain=unrelated.com; Path=/",
        "public=two; Domain=com; Path=/",
        "valid=three; Path=/",
      ),
      cookieResponse(),
    );
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar: new CookieJar() });

    await client.get("/init");
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("valid=three");
  });

  test("processes Set-Cookie headers in order so the last replacement wins", async () => {
    const fetchMock = mockResponses(
      cookieResponse("session=one; Path=/", "session=two; Path=/"),
      cookieResponse(),
    );
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar: new CookieJar() });

    await client.get("/init");
    await client.get("/offers");

    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("session=two");
  });

  test("surfaces cookie-store read failures before sending a request", async () => {
    const cookieJar = new CookieJar();
    const storeError = new Error("Cookie store unavailable");
    spyOn(cookieJar, "getCookieString").mockImplementation(() => Promise.reject(storeError));
    const fetchMock = mockResponses();
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar });

    await expect(client.get("/")).rejects.toBe(storeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces cookie-store write failures instead of silently losing state", async () => {
    mockResponses(cookieResponse("session=one; Path=/"));
    const cookieJar = new CookieJar();
    const storeError = new Error("Cookie store unavailable");
    spyOn(cookieJar, "setCookie").mockImplementation(() => Promise.reject(storeError));
    const client = new HttpClient({ baseUrl: "https://example.com", cookieJar });

    await expect(client.get("/")).rejects.toBe(storeError);
  });
});

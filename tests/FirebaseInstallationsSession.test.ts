import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { HttpClient } from "../src/http/HttpClient";
import { HttpError } from "../src/http/HttpError";
import { FirebaseInstallationsSession } from "../src/session/FirebaseInstallationsSession";

const config = {
  projectId: "example-travel",
  appId: "1:123456789:android:example",
  apiKey: "test-api-key",
  sdkVersion: "test:1.0.0",
};
const fid = `c${"0".repeat(21)}`;
const installationsUrl =
  "https://firebaseinstallations.googleapis.com/v1/projects/example-travel/installations";

function installationResponse(expiresIn = "604800s") {
  return {
    name: `projects/123456789/installations/${fid}`,
    fid,
    refreshToken: "test-refresh-token",
    authToken: { token: "test-installation-token", expiresIn },
  };
}

function mockFetchImplementation(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

afterEach(() => {
  mock.restore();
});

describe("FirebaseInstallationsSession", () => {
  test("creates an installation with a new FID and the configured JSON contract", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(installationResponse()),
    );
    const session = new FirebaseInstallationsSession(config);

    expect(await session.getAuthToken()).toBe("test-installation-token");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body: unknown = JSON.parse(String(init?.body));
    expect(String(url)).toBe(installationsUrl);
    expect(init?.method).toBe("POST");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-goog-api-key")).toBe(config.apiKey);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(body).toEqual({
      fid: expect.stringMatching(/^[cdef][\w-]{21}$/),
      authVersion: "FIS_v2",
      appId: config.appId,
      sdkVersion: config.sdkVersion,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reuses a cached token without sending another request", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(installationResponse()),
    );
    const session = new FirebaseInstallationsSession(config);

    expect(await session.getAuthToken()).toBe("test-installation-token");
    expect(await session.getAuthToken()).toBe("test-installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("deduplicates concurrent installation requests", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = mockFetchImplementation(() => pendingResponse);
    const session = new FirebaseInstallationsSession(config);

    const first = session.getAuthToken();
    const second = session.getAuthToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse?.(Response.json(installationResponse()));
    expect(await Promise.all([first, second])).toEqual([
      "test-installation-token",
      "test-installation-token",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refreshes near expiry using the stored FID and FIS_v2 refresh token", async () => {
    const now = spyOn(Date, "now").mockReturnValue(0);
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(installationResponse("120s")))
      .mockResolvedValueOnce(
        Response.json({ token: "test-refreshed-token", expiresIn: "3600s" }),
      );
    const session = new FirebaseInstallationsSession(config);

    await session.getAuthToken();
    now.mockReturnValue(59_000);
    expect(await session.getAuthToken()).toBe("test-installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(61_000);
    expect(await session.getAuthToken()).toBe("test-refreshed-token");
    expect(await session.getAuthToken()).toBe("test-refreshed-token");

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    const headers = new Headers(init?.headers);
    const body: unknown = JSON.parse(String(init?.body));
    expect(String(url)).toBe(`${installationsUrl}/${fid}/authTokens:generate`);
    expect(init?.method).toBe("POST");
    expect(headers.get("authorization")).toBe("FIS_v2 test-refresh-token");
    expect(headers.get("x-goog-api-key")).toBe(config.apiKey);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("cookie")).toBe(false);
    expect(body).toEqual({
      installation: { appId: config.appId, sdkVersion: config.sdkVersion },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("deduplicates concurrent token refreshes", async () => {
    const now = spyOn(Date, "now").mockReturnValue(0);
    let resolveRefresh: ((response: Response) => void) | undefined;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let requestCount = 0;
    const fetchMock = mockFetchImplementation(() => {
      requestCount += 1;
      return requestCount === 1
        ? Promise.resolve(Response.json(installationResponse("120s")))
        : pendingRefresh;
    });
    const session = new FirebaseInstallationsSession(config);
    await session.getAuthToken();
    now.mockReturnValue(61_000);

    const first = session.getAuthToken();
    const second = session.getAuthToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveRefresh?.(
      Response.json({ token: "test-refreshed-token", expiresIn: "3600s" }),
    );
    expect(await Promise.all([first, second])).toEqual([
      "test-refreshed-token",
      "test-refreshed-token",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("supports an injected HTTP client", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(installationResponse()),
    );
    const http = new HttpClient({ baseUrl: "https://example.test/firebase/" });
    const session = new FirebaseInstallationsSession(config, http);

    expect(await session.getAuthToken()).toBe("test-installation-token");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://example.test/firebase/projects/example-travel/installations",
    );
  });

  test("preserves injected HTTP errors and never retries the failed POST automatically", async () => {
    const error = new HttpError(
      "POST",
      installationsUrl,
      new Response(null, { status: 503 }),
      { error: { message: "Temporarily unavailable" } },
    );
    const http = new HttpClient({ baseUrl: "https://example.test/" });
    const postMock = spyOn(http, "post").mockRejectedValue(error);
    const session = new FirebaseInstallationsSession(config, http);

    await expect(session.getAuthToken()).rejects.toBe(error);
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  test("preserves transport errors and permits a later explicit attempt", async () => {
    const error = new TypeError("Connection failed");
    const fetchMock = spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(Response.json(installationResponse()));
    const session = new FirebaseInstallationsSession(config);

    await expect(session.getAuthToken()).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await session.getAuthToken()).toBe("test-installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keeps the installation after a failed refresh without creating a replacement", async () => {
    const now = spyOn(Date, "now").mockReturnValue(0);
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(installationResponse("120s")))
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ token: "test-refreshed-token", expiresIn: "3600s" }),
      );
    const session = new FirebaseInstallationsSession(config);
    await session.getAuthToken();
    now.mockReturnValue(61_000);

    await expect(session.getAuthToken()).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await session.getAuthToken()).toBe("test-refreshed-token");
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      `${installationsUrl}/${fid}/authTokens:generate`,
    );
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("authorization"))
      .toBe("FIS_v2 test-refresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("preserves malformed JSON as a parsing error", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"authToken":'),
    );
    const session = new FirebaseInstallationsSession(config);

    await expect(session.getAuthToken()).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["null", null],
    ["array", []],
    ["missing fields", {}],
    ["empty name", { ...installationResponse(), name: "" }],
    ["invalid FID", { ...installationResponse(), fid: "../unexpected-path" }],
    ["missing refresh token", { ...installationResponse(), refreshToken: "" }],
    ["missing auth token", { ...installationResponse(), authToken: null }],
    [
      "empty auth token",
      { ...installationResponse(), authToken: { token: "", expiresIn: "604800s" } },
    ],
  ] satisfies [string, unknown][])("rejects an invalid installation response: %s", async (_label, body) => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    const session = new FirebaseInstallationsSession(config);

    await expect(session.getAuthToken()).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    "0s",
    "-1s",
    "Infinitys",
    "1e3s",
    "120",
    "1.1234567890s",
    "9007199254740991s",
  ])("rejects an invalid or unsafe expiry duration: %s", async (expiresIn) => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(installationResponse(expiresIn)),
    );
    const session = new FirebaseInstallationsSession(config);

    await expect(session.getAuthToken()).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("accepts Firebase duration values containing fractional seconds", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(installationResponse("120.5s")),
    );
    const session = new FirebaseInstallationsSession(config);

    expect(await session.getAuthToken()).toBe("test-installation-token");
  });

  test("validates refreshed token shapes and keeps secret values out of errors", async () => {
    const now = spyOn(Date, "now").mockReturnValue(0);
    const fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(installationResponse("120s")))
      .mockResolvedValueOnce(
        Response.json({ token: "secret-response-marker", expiresIn: "invalid" }),
      );
    const session = new FirebaseInstallationsSession(config);
    await session.getAuthToken();
    now.mockReturnValue(61_000);

    const error: unknown = await session.getAuthToken().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("secret-response-marker");
    expect(String(error)).not.toContain("test-refresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each(["projectId", "appId", "apiKey", "sdkVersion"] as const)(
    "rejects empty %s configuration before sending requests",
    (key) => {
      const fetchMock = spyOn(globalThis, "fetch");

      expect(() => new FirebaseInstallationsSession({ ...config, [key]: " " }))
        .toThrow(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

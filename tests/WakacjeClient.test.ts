import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CookieJar } from "tough-cookie";
import { HttpClient } from "../src/http/HttpClient";
import { HttpError } from "../src/http/HttpError";
import { WakacjeClient } from "../src/services/WakacjeClient";
import type { OfferListingOptions } from "../src/services/WakacjeClient";

const config = {
  authorization: "example-raw-authorization",
  deviceId: "00000000-0000-4000-8000-000000000000",
};

afterEach(() => {
  mock.restore();
});

function mockResponses(...responses: Response[]) {
  let nextResponse = 0;
  const implementation = async () => {
    const response = responses[nextResponse++];
    if (!response) throw new Error("Unexpected request in Wakacje client test");
    return response;
  };
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

function destinationCatalog() {
  return {
    data: [
      { form: "destinationCountry", type: "countryIconSelect", data: [{ value: 16, label: "Turcja" }] },
      {
        form: "destinationCountry",
        type: "countrySelect",
        data: [
          { value: 16, label: "Turcja", iso2Code: "TR", expandable: true },
          { value: 521, label: "Rejsy", expandable: true },
        ],
      },
    ],
    meta: { count: 2 },
  };
}

function providerCatalog() {
  return {
    data: [
      { type: "cateringList", data: [{ value: 1, attributes: { label: "All Inclusive" } }] },
      {
        type: "providerList",
        data: [
          { id: 999, value: 17, attributes: { label: "Itaka" } },
          { value: 740, attributes: { label: "TUI" } },
          { value: 17, attributes: { label: "Itaka" } },
        ],
      },
    ],
  };
}

describe("WakacjeClient", () => {
  test("requests the verified listing endpoint with defaults and raw authorization", async () => {
    const payload = { data: [{ sample: "offer" }] };
    const fetchMock = mockResponses(Response.json(payload, { headers: { "x-request-id": "test-1" } }));
    const client = new WakacjeClient(config);

    const response = await client.listOffers();

    const call = fetchMock.mock.calls[0];
    const url = new URL(String(call?.[0]));
    const headers = new Headers(call?.[1]?.headers);
    expect(url.origin + url.pathname).toBe("https://thor.wakacje.pl/api/v1/wak-logic/search/listing");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      adultCount: "2",
      childCount: "0",
      imageLimit: "8",
      limit: "5",
      promotionList: "[1]",
    });
    expect(call?.[1]?.method).toBe("GET");
    expect(call?.[1]?.body).toBeUndefined();
    expect(headers.get("Authorization")).toBe(config.authorization);
    expect(headers.get("X-Device-ID")).toBe(config.deviceId);
    expect(headers.get("Device")).toBe("mobile");
    expect(headers.get("Environment")).toBe("mobile app");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("Cookie")).toBe(false);
    expect(headers.has("User-Agent")).toBe(false);
    expect(response.data).toEqual(payload);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("test-1");
  });

  test("encodes custom listing parameters and an opaque next-page cursor", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));
    const client = new WakacjeClient(config);

    await client.listOffers({
      adultCount: 3,
      childCount: 1,
      imageLimit: 0,
      limit: 10,
      promotionList: [1, 2],
      cursor: "v1:2&extra=encoded",
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      adultCount: "3",
      childCount: "1",
      imageLimit: "0",
      limit: "10",
      promotionList: "[1,2]",
      cursor: "v1:2&extra=encoded",
    });
    expect(url.searchParams.has("extra")).toBe(false);
  });

  test("accepts an explicitly empty promotion list", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));

    await new WakacjeClient(config).listOffers({ promotionList: [] });

    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("promotionList")).toBe("[]");
  });

  test("forwards caller cancellation through the HTTP client's combined abort signal", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));
    const controller = new AbortController();
    const reason = new Error("Caller cancelled the listing request");

    await new WakacjeClient(config).listOffers({}, controller.signal);
    const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);

    controller.abort(reason);

    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
  });

  test("JSON-encodes the verified catering filter only when explicitly provided", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }), Response.json({ data: [] }));
    const client = new WakacjeClient(config);

    await client.listOffers({ cateringList: [1] });
    await client.listOffers({ cateringList: [] });

    const selected = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(selected.searchParams.get("cateringList")).toBe("[1]");
    expect(selected.searchParams.get("promotionList")).toBe("[1]");
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("cateringList")).toBe("[]");
  });

  test("encodes the observed destinationCountry and transportType filters as JSON arrays", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));

    await new WakacjeClient(config).listOffers({ destinationCountry: [16], transportType: [1] });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("destinationCountry")).toBe("[16]");
    expect(url.searchParams.get("transportType")).toBe("[1]");
  });

  test("encodes the verified tour filter as offerType without inventing an offerTypeList parameter", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));

    await new WakacjeClient(config).listOffers({ offerType: [2], cursor: "v1:2" });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("offerType")).toBe("[2]");
    expect(url.searchParams.has("offerTypeList")).toBe(false);
    expect(url.searchParams.get("cursor")).toBe("v1:2");
  });

  test("encodes the verified providerList filter using catalog provider identifiers", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));

    await new WakacjeClient(config).listOffers({ providerList: [17] });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("providerList")).toBe("[17]");
  });

  test("allows explicitly empty destination, transport, offer-type, and provider filters", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));

    await new WakacjeClient(config).listOffers({
      destinationCountry: [], transportType: [], offerType: [], providerList: [],
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("destinationCountry")).toBe("[]");
    expect(url.searchParams.get("transportType")).toBe("[]");
    expect(url.searchParams.get("offerType")).toBe("[]");
    expect(url.searchParams.get("providerList")).toBe("[]");
  });

  test.each([1, 11, 13] as const)("encodes supported listing sort order %s when supplied", async (order) => {
    const fetchMock = mockResponses(Response.json({ data: [] }));

    await new WakacjeClient(config).listOffers({ order });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("order")).toBe(String(order));
  });

  test("keeps an explicit price order on a request carrying the API's opaque continuation cursor", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }));

    await new WakacjeClient(config).listOffers({ order: 1, cursor: "v1:2" });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("order")).toBe("1");
    expect(url.searchParams.get("cursor")).toBe("v1:2");
  });

  test("rejects unsupported or malformed sort orders before requesting data", async () => {
    const fetchMock = mockResponses();
    const client = new WakacjeClient(config);

    for (const order of [0, 2, 12, 1.5, Number.NaN, null, "1"]) {
      const input: unknown = { order };
      await expect(client.listOffers(input as OfferListingOptions)).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects invalid country, transport, offer-type, and provider identifiers before fetching", async () => {
    const fetchMock = mockResponses();
    const client = new WakacjeClient(config);

    for (const field of ["destinationCountry", "transportType", "offerType", "providerList"] as const) {
      for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(client.listOffers({ [field]: [value] })).rejects.toBeInstanceOf(RangeError);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects invalid catering identifiers before making requests", async () => {
    const fetchMock = mockResponses();
    const client = new WakacjeClient(config);

    for (const cateringList of [[-1], [0.5], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
      await expect(client.listOffers({ cateringList })).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requests the verified filters endpoint without inventing a filter schema", async () => {
    const payload: unknown = { sample: ["filter"] };
    const fetchMock = mockResponses(Response.json(payload));
    const client = new WakacjeClient(config);

    const response = await client.getFilters();

    const call = fetchMock.mock.calls[0];
    const url = new URL(String(call?.[0]));
    expect(url.origin + url.pathname).toBe("https://thor.wakacje.pl/api/v1/wak-logic/search/filters");
    expect(Object.fromEntries(url.searchParams)).toEqual({ offerTypeList: "[]" });
    expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe(config.authorization);
    expect(response.data).toEqual(payload);
  });

  test("parses unique providers from the verified filters catalog using value identifiers", async () => {
    const fetchMock = mockResponses(Response.json(providerCatalog(), {
      headers: { "x-request-id": "providers" },
    }));

    const response = await new WakacjeClient(config).getProviders();

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://thor.wakacje.pl/api/v1/wak-logic/search/filters");
    expect(Object.fromEntries(url.searchParams)).toEqual({ offerTypeList: "[]" });
    expect(response.data).toEqual([{ id: 17, label: "Itaka" }, { id: 740, label: "TUI" }]);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("providers");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("forwards caller cancellation through provider discovery and the filters request", async () => {
    const fetchMock = mockResponses(Response.json(providerCatalog()));
    const controller = new AbortController();
    const reason = new Error("Caller cancelled providers");

    await new WakacjeClient(config).getProviders(controller.signal);
    const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    controller.abort(reason);

    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
  });

  test.each([
    null,
    [],
    {},
    { data: null },
    { data: [] },
    { data: [{ type: "cateringList", data: [] }] },
    { data: [{ type: "providerList", data: null }] },
    { data: [{ type: "providerList", data: [] }] },
    { data: [{ type: "providerList", data: [null] }] },
    { data: [{ type: "providerList", data: [{ value: 17, attributes: null }] }] },
    { data: [{ type: "providerList", data: [{ value: 0, attributes: { label: "Itaka" } }] }] },
    { data: [{ type: "providerList", data: [{ value: -1, attributes: { label: "Itaka" } }] }] },
    { data: [{ type: "providerList", data: [{ value: 0.5, attributes: { label: "Itaka" } }] }] },
    { data: [{ type: "providerList", data: [{ value: 17, attributes: { label: " " } }] }] },
    { data: [{ type: "providerList", data: [{ value: 17, attributes: { label: 42 } }] }] },
  ].map((payload) => ({ payload })))("rejects malformed provider catalogs %j", async ({ payload }) => {
    const fetchMock = mockResponses(Response.json(payload));

    await expect(new WakacjeClient(config).getProviders()).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("requests the verified destinations endpoint without query parameters and deduplicates countries", async () => {
    const fetchMock = mockResponses(Response.json(destinationCatalog(), {
      headers: { "x-request-id": "destinations" },
    }));

    const response = await new WakacjeClient(config).getDestinations();

    const call = fetchMock.mock.calls[0];
    const url = new URL(String(call?.[0]));
    expect(url.origin + url.pathname).toBe("https://thor.wakacje.pl/api/v1/wak-logic/search/destinations");
    expect(url.search).toBe("");
    expect(call?.[1]?.method).toBe("GET");
    expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe(config.authorization);
    expect(response.data).toEqual([
      { id: 16, label: "Turcja", iso2Code: "TR" },
      { id: 521, label: "Rejsy", iso2Code: null },
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("destinations");
  });

  test("preserves ISO codes if the featured duplicate occurs after the complete country group", async () => {
    const payload = destinationCatalog();
    payload.data.reverse();
    mockResponses(Response.json(payload));

    expect((await new WakacjeClient(config).getDestinations()).data).toEqual([
      { id: 16, label: "Turcja", iso2Code: "TR" },
      { id: 521, label: "Rejsy", iso2Code: null },
    ]);
  });

  test("forwards caller cancellation to the destinations request", async () => {
    const fetchMock = mockResponses(Response.json(destinationCatalog()));
    const controller = new AbortController();
    const reason = new Error("Caller cancelled destinations");

    await new WakacjeClient(config).getDestinations(controller.signal);
    const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    controller.abort(reason);

    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
  });

  test.each([
    null,
    [],
    {},
    { data: null },
    { data: [] },
    { data: [{ form: "destinationCountry", data: [] }] },
    { data: [{ form: "unexpected", data: [{ value: 16, label: "Turcja" }] }] },
    { data: [{ form: "destinationCountry", data: [null] }] },
    { data: [{ form: "destinationCountry", data: [{ value: -1, label: "Turcja" }] }] },
    { data: [{ form: "destinationCountry", data: [{ value: 0.5, label: "Turcja" }] }] },
    { data: [{ form: "destinationCountry", data: [{ value: 16, label: " " }] }] },
    { data: [{ form: "destinationCountry", data: [{ value: 16, label: "Turcja", iso2Code: "tr" }] }] },
  ].map((payload) => ({ payload })))("rejects malformed destination catalogs %j", async ({ payload }) => {
    const fetchMock = mockResponses(Response.json(payload));

    await expect(new WakacjeClient(config).getDestinations()).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("allows transport injection and applies the API headers on every request", async () => {
    const fetchMock = mockResponses(Response.json({ data: [] }), Response.json({}));
    const http = new HttpClient({ baseUrl: "https://fixture.example/api/", headers: { Authorization: "old" } });
    const client = new WakacjeClient(config, http);

    await client.listOffers();
    await client.getFilters();

    expect(String(fetchMock.mock.calls[0]?.[0])).toStartWith("https://fixture.example/api/search/listing?");
    expect(String(fetchMock.mock.calls[1]?.[0])).toStartWith("https://fixture.example/api/search/filters?");
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get("Authorization")).toBe(config.authorization);
      expect(new Headers(call[1]?.headers).get("X-Device-ID")).toBe(config.deviceId);
    }
  });

  test("can reuse cookies received by the service through an explicitly supplied jar", async () => {
    const cookieJar = new CookieJar();
    const fetchMock = mockResponses(
      Response.json({ data: [] }, { headers: { "Set-Cookie": "example=value; Path=/; Secure" } }),
      Response.json({}),
    );
    const client = new WakacjeClient({ ...config, cookieJar });

    await client.listOffers();
    await client.getFilters();

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Cookie")).toBe(false);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Cookie")).toBe("example=value");
  });

  test.each([null, [], {}, { data: null }, { data: {} }, { data: "invalid" }, 42].map((payload) => ({ payload })))(
    "rejects a malformed listing response %j",
    async ({ payload }) => {
      mockResponses(Response.json(payload));

      await expect(new WakacjeClient(config).listOffers()).rejects.toThrow(
        "Invalid Wakacje offer listing response",
      );
    },
  );

  test.each([0, 70])("normalizes an explicit null terminal page with total %i while preserving metadata", async (total) => {
    const fetchMock = mockResponses(Response.json({
      data: null, meta: { count: 0, total, cursor: "" },
    }, { headers: { "x-request-id": "empty-result" } }));

    const response = await new WakacjeClient(config).listOffers();

    expect(response.data).toEqual({ data: [], meta: { count: 0, total, cursor: "" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("empty-result");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    { data: null, meta: {} },
    { data: null, meta: null },
    { data: null, meta: [] },
    { data: null, meta: { count: 0, total: 0 } },
    { data: null, meta: { count: 0, total: 0, cursor: null } },
    { data: null, meta: { count: 1, total: 0, cursor: "" } },
    { data: null, meta: { count: 0, total: -1, cursor: "" } },
    { data: null, meta: { count: 0, total: 0, cursor: "next-page" } },
    { data: null, meta: { count: "0", total: 0, cursor: "" } },
  ].map((payload) => ({ payload })))(
    "rejects null listing data without the exact zero-result metadata %j",
    async ({ payload }) => {
      const fetchMock = mockResponses(Response.json(payload));

      await expect(new WakacjeClient(config).listOffers()).rejects.toBeInstanceOf(TypeError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    { data: [], meta: null },
    { data: [], meta: [] },
    { data: [], meta: { cursor: 123 } },
    { data: [], meta: { cursor: {} } },
    { data: [], meta: { total: -1 } },
    { data: [], meta: { total: "10" } },
    { data: [], meta: { count: 0.5 } },
    { data: [], meta: { count: null } },
    { data: [], meta: { total: Number.MAX_SAFE_INTEGER + 1 } },
  ].map((payload) => ({ payload })))(
    "rejects malformed pagination metadata %j",
    async ({ payload }) => {
      const fetchMock = mockResponses(Response.json(payload));

      await expect(new WakacjeClient(config).listOffers()).rejects.toBeInstanceOf(TypeError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("rejects an empty listing response", async () => {
    mockResponses(new Response(null, { status: 204 }));

    await expect(new WakacjeClient(config).listOffers()).rejects.toBeInstanceOf(TypeError);
  });

  test("preserves transport HTTP errors without retrying", async () => {
    const fetchMock = mockResponses(Response.json({ message: "Unauthorized" }, { status: 401 }));

    await expect(new WakacjeClient(config).listOffers()).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(["", " ", " value", "value ", "value\r\nInjected: true", "nonascii-ą"])(
    "rejects unsafe configuration values without echoing them: %j",
    (value) => {
      const fetchMock = mockResponses();

      expect(() => new WakacjeClient({ ...config, authorization: value })).toThrow(TypeError);
      expect(() => new WakacjeClient({ ...config, deviceId: value })).toThrow(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each([
    { adultCount: 0 },
    { adultCount: 1.5 },
    { adultCount: Number.NaN },
    { childCount: -1 },
    { childCount: 0.5 },
    { imageLimit: -1 },
    { imageLimit: Number.POSITIVE_INFINITY },
    { limit: 0 },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { promotionList: [-1] },
    { promotionList: [0.5] },
    { promotionList: [Number.NaN] },
  ] satisfies OfferListingOptions[])("rejects invalid listing options %j before fetch", async (options) => {
    const fetchMock = mockResponses();

    await expect(new WakacjeClient(config).listOffers(options)).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects an empty cursor before fetch", async () => {
    const fetchMock = mockResponses();

    await expect(new WakacjeClient(config).listOffers({ cursor: "" })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

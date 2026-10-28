import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/http/HttpError";
import type { HttpResponse } from "../src/http/types";
import { OfferCollector } from "../src/offers/OfferCollector";
import type { CollectionProgress } from "../src/offers/OfferCollector";
import type { OfferListing, OfferListingOptions } from "../src/services/WakacjeClient";
import { OfferRepository } from "../src/storage/OfferRepository";

const repositories = new Set<OfferRepository>();
const temporaryDirectories: string[] = [];

function fixture(id: number) {
  return {
    id,
    label: `Example Resort ${id}`,
    hash: `public-source-hash-${id}`,
    object: { id: id + 100, category: 4 },
    localisation: {
      country: { name: "Egipt", iso2Code: "EG" },
      region: { name: "Marsa El Alam" },
    },
    departure: { id: 2622, label: "Katowice" },
    transport: { startDate: "2026-10-23", endDate: "2026-10-31", nights: 7 },
    catering: { id: 1, label: "All Inclusive" },
    provider: { code: "EXAMPLE", label: "Example Travel" },
    roomId: "",
    rating: { value: 8.5 },
    price: { type: "total", currency: "PLN", value: 2970 + id },
  };
}

function page(
  data: readonly unknown[],
  cursor: string | null | undefined = null,
  total?: number,
): HttpResponse<OfferListing> {
  return {
    data: {
      data,
      meta: {
        ...(cursor === undefined ? {} : { cursor }),
        ...(total === undefined ? {} : { total }),
      },
    },
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    url: "https://example.test/public/search/listing",
  };
}

function setup(responses: readonly (HttpResponse<OfferListing> | Error)[], path = ":memory:") {
  const repository = new OfferRepository(path);
  repositories.add(repository);
  const queue = [...responses];
  const listOffers = mock(async (
    _options?: OfferListingOptions,
    _signal?: AbortSignal,
  ): Promise<HttpResponse<OfferListing>> => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected extra listing request");
    if (response instanceof Error) throw response;
    return response;
  });
  return { repository, listOffers, collector: new OfferCollector({ listOffers }, repository) };
}

function httpError(status: number, retryAfter?: string): HttpError {
  return new HttpError(
    "GET",
    "https://example.test/public/search/listing",
    new Response(null, {
      status,
      headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
    }),
    { error: "Request could not be completed" },
  );
}

afterEach(() => {
  mock.restore();
  for (const repository of repositories) repository.close();
  repositories.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("OfferCollector", () => {
  test("follows opaque response cursors until the API ends pagination without an implicit page cap", async () => {
    const firstCursor = "opaque-cursor+one/==";
    const secondCursor = "opaque-cursor+two/==";
    const { collector, repository, listOffers } = setup([
      page([fixture(1)], firstCursor, 3),
      page([fixture(2)], secondCursor, 3),
      page([fixture(3)], null, 3),
    ]);
    const progress: CollectionProgress[] = [];

    const result = await collector.collect({
      profile: "last-minute",
      delayMs: 0,
      onProgress: (value) => progress.push(value),
    });

    expect(result).toMatchObject({
      profile: "last-minute", status: "completed", stopReason: "end-cursor",
      pages: 3, received: 3, uniqueSourceIds: 3, inserted: 3, duplicates: 0, rejected: 0, reportedTotal: 3,
    });
    expect(listOffers.mock.calls.map(([query]) => query?.cursor)).toEqual([
      undefined, firstCursor, secondCursor,
    ]);
    expect(listOffers.mock.calls[0]?.[0]).toEqual({
      adultCount: 2, childCount: 0, limit: 100, imageLimit: 0, order: 1, promotionList: [1],
    });
    expect(progress.map((value) => value.pages)).toEqual([1, 2, 3]);
    expect(progress.map((value) => value.uniqueSourceIds)).toEqual([1, 2, 3]);
    expect(repository.getStats().observations).toBe(3);
  });

  test("uses the All Inclusive filter and configurable page size without requesting images", async () => {
    const { collector, repository, listOffers } = setup([page([fixture(1)])]);

    const result = await collector.collect({ profile: "all-inclusive", pageSize: 37, delayMs: 0 });

    expect(listOffers.mock.calls[0]?.[0]).toMatchObject({
      adultCount: 2, childCount: 0, limit: 37, imageLimit: 0,
      promotionList: [], cateringList: [1],
    });
    expect(result.profile).toBe("all-inclusive");
    expect(repository.getLatest("all-inclusive")).toHaveLength(1);
  });

  test("collects the unfiltered all profile without a promotion or catering restriction", async () => {
    const { collector, repository, listOffers } = setup([page([fixture(1)])]);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(listOffers.mock.calls[0]?.[0]).toEqual({
      adultCount: 2, childCount: 0, limit: 100, imageLimit: 0, order: 1, promotionList: [],
    });
    expect(result).toMatchObject({ profile: "all", status: "completed", inserted: 1 });
    expect(repository.getLatest("all")).toHaveLength(1);
  });

  test("commits each page before progress is reported and persists observations across reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wakacje-offer-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "offers.sqlite");
    const first = fixture(1);
    const { collector, repository } = setup([
      page([first], "next-page", 2), page([fixture(2)], null, 2),
    ], path);
    const savedCounts: number[] = [];

    const result = await collector.collect({
      profile: "last-minute",
      delayMs: 0,
      onProgress: () => savedCounts.push(repository.getStats().observations),
    });

    expect(savedCounts).toEqual([1, 2]);
    repository.close();
    repositories.delete(repository);
    const reopened = new OfferRepository(path);
    repositories.add(reopened);
    expect(reopened.getStats().observations).toBe(2);
    expect(reopened.getLatest()[0]).toMatchObject({ runId: result.runId, rawJson: JSON.stringify(first) });
  });

  test("quarantines invalid source items while continuing to collect valid offers", async () => {
    const invalid = { id: "invalid", unrecognizedPublicField: ["public-value"] };
    const { collector, repository } = setup([
      page([fixture(1), invalid], "next-page", 3), page([fixture(2)], null, 3),
    ]);
    const saveRejected = spyOn(repository, "saveRejected");

    const result = await collector.collect({ profile: "last-minute", delayMs: 0 });

    expect(result).toMatchObject({ pages: 2, received: 3, inserted: 2, rejected: 1 });
    expect(repository.getStats()).toMatchObject({ observations: 2, rejected: 1 });
    expect(saveRejected.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        page: 1, itemIndex: 1, rawJson: JSON.stringify(invalid), reason: expect.any(String),
      }),
    ]);
  });

  test("records already committed offers when saving rejected source items fails", async () => {
    const { collector, repository } = setup([page([fixture(1), { malformed: true }])]);
    const failure = new Error("Unable to save rejected source items");
    spyOn(repository, "saveRejected").mockImplementation(() => {
      throw failure;
    });
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({ profile: "all", delayMs: 0 })).rejects.toBe(failure);

    expect(repository.getStats()).toMatchObject({ observations: 1, rejected: 0 });
    expect(finish.mock.calls[0]?.[1]).toMatchObject({
      status: "failed", pages: 1, received: 2, uniqueSourceIds: 1, inserted: 1, rejected: 0,
    });
  });

  test("deduplicates identical snapshots within a page without losing received counts", async () => {
    const source = fixture(1);
    const { collector, repository } = setup([page([source, source], null, 2)]);

    const result = await collector.collect({ profile: "last-minute", delayMs: 0 });

    expect(result).toMatchObject({
      status: "limited", stopReason: "count-mismatch",
      received: 2, uniqueSourceIds: 1, inserted: 1, duplicates: 1, rejected: 0,
    });
    expect(repository.getStats().observations).toBe(1);
  });

  test("fails on a repeated cursor while retaining previously committed offers", async () => {
    const { collector, repository, listOffers } = setup([
      page([fixture(1)], "repeated-cursor", 3),
      page([fixture(2)], "repeated-cursor", 3),
    ]);
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({ profile: "last-minute", delayMs: 0 })).rejects.toThrow(/cursor/i);

    expect(listOffers).toHaveBeenCalledTimes(2);
    expect(repository.getLatest().some((item) => item.offer.sourceId === 1)).toBe(true);
    expect(finish.mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed" });
  });

  test("fails on a repeated nonempty page even if the second response has a terminal cursor", async () => {
    const source = fixture(1);
    const { collector, repository, listOffers } = setup([
      page([source], "next-page", 2), page([source], null, 2),
    ]);
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({ profile: "last-minute", delayMs: 0 })).rejects.toThrow(/page/i);

    expect(listOffers).toHaveBeenCalledTimes(2);
    expect(repository.getStats().observations).toBe(1);
    expect(finish.mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed" });
  });

  test("detects repeated visible listings despite rotating hashes and a different item order", async () => {
    const first = fixture(1);
    const second = fixture(2);
    const { collector, repository, listOffers } = setup([
      page([first, second], "next-page", 4),
      page([{ ...second, hash: "rotated-second" }, { ...first, hash: "rotated-first" }], "", 4),
    ]);
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({ profile: "all", delayMs: 0 })).rejects.toThrow(/repeated.*page/i);

    expect(listOffers).toHaveBeenCalledTimes(2);
    expect(repository.getStats().observations).toBe(4);
    expect(finish.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "failed", received: 4, uniqueSourceIds: 2, inserted: 4,
    });
  });

  test("reports incomplete unique coverage when repeated source IDs satisfy only the received count", async () => {
    const second = fixture(2);
    const { collector } = setup([
      page([fixture(1), second], "next-page", 4),
      page([{ ...second, hash: "rotated-second" }, fixture(3)], "", 4),
    ]);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(result).toMatchObject({
      status: "limited", stopReason: "count-mismatch",
      received: 4, inserted: 4, uniqueSourceIds: 3, reportedTotal: 4,
    });
  });

  test("allows partially overlapping pages that still cover all reported source IDs", async () => {
    const second = fixture(2);
    const { collector } = setup([
      page([fixture(1), second], "next-page", 3),
      page([{ ...second, hash: "rotated-second" }, fixture(3)], "", 3),
    ]);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(result).toMatchObject({
      status: "completed", stopReason: "end-cursor",
      received: 4, uniqueSourceIds: 3, reportedTotal: 3,
    });
  });

  test("marks an explicit maxPages stop as limited rather than complete", async () => {
    const { collector, repository, listOffers } = setup([
      page([fixture(1)], "still-more-pages", 10),
    ]);
    const finish = spyOn(repository, "finishRun");

    const result = await collector.collect({ profile: "last-minute", delayMs: 0, maxPages: 1 });

    expect(result).toMatchObject({
      status: "limited", stopReason: "max-pages", pages: 1, received: 1, inserted: 1,
    });
    expect(listOffers).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]?.[1]).toMatchObject({ status: "limited" });
  });

  test("preserves a 401 HTTP error and does not retry authorization failures", async () => {
    const error = httpError(401);
    const { collector, repository, listOffers } = setup([error]);
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({ profile: "last-minute", delayMs: 0 })).rejects.toBe(error);

    expect(listOffers).toHaveBeenCalledTimes(1);
    expect(repository.getStats().observations).toBe(0);
    expect(finish.mock.calls[0]?.[1]).toMatchObject({ status: "failed", errorKind: "HTTP_401" });
  });

  test("retries a native TimeoutError within the same read-only listing scope", async () => {
    const timeout = new DOMException("Listing request timed out", "TimeoutError");
    const { collector, repository, listOffers } = setup([timeout, page([fixture(1)], "", 1)]);

    const result = await collector.collect({ profile: "all", offerType: [2], delayMs: 0 });

    expect(result).toMatchObject({ status: "completed", pages: 1, inserted: 1, uniqueSourceIds: 1 });
    expect(listOffers).toHaveBeenCalledTimes(2);
    expect(listOffers.mock.calls[0]?.[0]).toEqual(listOffers.mock.calls[1]?.[0]);
    expect(repository.getStats().observations).toBe(1);
  });

  test.each([
    { label: "caller cancellation", error: new DOMException("Caller cancelled", "AbortError") },
    { label: "validation failure", error: new TypeError("Invalid listing response") },
  ])("does not retry $label as if it were a request timeout", async ({ error }) => {
    const { collector, listOffers } = setup([error]);

    await expect(collector.collect({ profile: "all", delayMs: 0 })).rejects.toBe(error);

    expect(listOffers).toHaveBeenCalledTimes(1);
  });

  test("honors Retry-After for a temporary 429 response and then saves the successful page", async () => {
    const { collector, repository, listOffers } = setup([
      httpError(429, "0"), page([fixture(1)]),
    ]);

    const result = await collector.collect({ profile: "last-minute", delayMs: 0 });

    expect(result).toMatchObject({ status: "completed", inserted: 1, pages: 1 });
    expect(listOffers).toHaveBeenCalledTimes(2);
    expect(repository.getStats().observations).toBe(1);
  });

  test("retries a temporary HTTP 500 within the bounded read-only workflow", async () => {
    const { collector, repository, listOffers } = setup([
      httpError(500, "0"), page([fixture(1)], "", 1),
    ]);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(result).toMatchObject({ status: "completed", inserted: 1, pages: 1 });
    expect(listOffers).toHaveBeenCalledTimes(2);
    expect(repository.getStats().observations).toBe(1);
  });

  test("bounds repeated 429 retries and preserves the final HTTP error", async () => {
    const error = httpError(429, "0");
    const { collector, repository, listOffers } = setup([error, error, error, error]);

    await expect(collector.collect({ profile: "last-minute", delayMs: 0 })).rejects.toBe(error);

    expect(listOffers).toHaveBeenCalledTimes(4);
    expect(repository.getStats().observations).toBe(0);
  }, 10_000);

  test("stops at cancellation and preserves the first committed page", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Collection cancelled", "AbortError");
    const { collector, repository, listOffers } = setup([
      page([fixture(1)], "next-page", 2), page([fixture(2)], null, 2),
    ]);
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({
      profile: "last-minute", delayMs: 0, signal: controller.signal,
      onProgress: () => controller.abort(reason),
    })).rejects.toBe(reason);

    expect(listOffers).toHaveBeenCalledTimes(1);
    expect(repository.getStats().observations).toBe(1);
    expect(finish.mock.calls[0]?.[1]).toMatchObject({
      status: "failed", errorKind: "AbortError", pages: 1, received: 1, inserted: 1,
    });
  });

  test("forwards the caller's abort signal to each listing request", async () => {
    const controller = new AbortController();
    const { collector, listOffers } = setup([
      page([fixture(1)], "next-page", 2), page([fixture(2)], null, 2),
    ]);

    await collector.collect({ profile: "all", delayMs: 0, signal: controller.signal });

    expect(listOffers).toHaveBeenCalledTimes(2);
    expect(listOffers.mock.calls.map((call) => call[1])).toEqual([
      controller.signal, controller.signal,
    ]);
  });

  test("continues past an empty intermediate page with a cursor and positive total", async () => {
    const { collector, repository, listOffers } = setup([
      page([fixture(1)], "empty-page-cursor", 2),
      page([], "nonempty-next-page", 2),
      page([fixture(2)], null, 2),
    ]);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(result).toMatchObject({
      status: "completed", stopReason: "end-cursor", pages: 3,
      received: 2, inserted: 2, reportedTotal: 2,
    });
    expect(listOffers.mock.calls.map(([query]) => query?.cursor)).toEqual([
      undefined, "empty-page-cursor", "nonempty-next-page",
    ]);
    expect(repository.getStats().observations).toBe(2);
  });

  test("preserves a previously reported total when the final empty response reports zero", async () => {
    const { collector, listOffers } = setup([
      page([fixture(1)], "final-empty-page", 10), page([], "", 0),
    ]);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(result).toMatchObject({
      status: "limited", stopReason: "count-mismatch", pages: 2,
      received: 1, uniqueSourceIds: 1, inserted: 1, reportedTotal: 10,
    });
    expect(listOffers).toHaveBeenCalledTimes(2);
  });

  test("reports an early terminal cursor below the advertised total as a count mismatch", async () => {
    const { collector, repository } = setup([page([fixture(1)], "", 100)]);
    const finish = spyOn(repository, "finishRun");
    const result = await collector.collect({ profile: "all", delayMs: 0 });
    expect(result).toMatchObject({ status: "limited", stopReason: "count-mismatch", received: 1, uniqueSourceIds: 1 });
    expect(finish.mock.calls[0]?.[1]).toMatchObject({ reportedTotal: 100, stopReason: "count-mismatch" });
  });

  test.each([
    { pages: 100, total: 10_001, stopReason: "count-mismatch" },
    { pages: 101, total: 10_000, stopReason: "count-mismatch" },
    { pages: 101, total: 10_001, stopReason: "api-window" },
  ])("recognizes the API window only beyond both observed thresholds: %j", async ({ pages, total, stopReason }) => {
    const responses = Array.from({ length: pages }, (_, index) => page(
      [fixture(index + 1)], index === pages - 1 ? "" : `cursor-${index + 1}`, total,
    ));
    const { collector } = setup(responses);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(result).toMatchObject({ status: "limited", stopReason, uniqueSourceIds: pages, reportedTotal: total });
  });

  test("leaves the reported total unknown when the API never supplies it", async () => {
    const { collector } = setup([page([fixture(1)], "next-page"), page([fixture(2)], "")]);

    const result = await collector.collect({ profile: "all", delayMs: 0 });

    expect(result).toMatchObject({
      status: "completed", stopReason: "end-cursor", reportedTotal: null, uniqueSourceIds: 2,
    });
  });

  test("retains verified country and transport filters across cursor requests", async () => {
    const { collector, listOffers } = setup([
      page([fixture(1)], "next", 2), page([fixture(2)], "", 2),
    ]);
    await collector.collect({ profile: "all", destinationCountry: [16], transportType: [1], delayMs: 0 });
    for (const [query] of listOffers.mock.calls) {
      expect(query).toMatchObject({ destinationCountry: [16], transportType: [1], promotionList: [] });
    }
  });

  test("retains the verified global tour offerType filter across cursor requests and stores it in the run query", async () => {
    const { collector, repository, listOffers } = setup([
      page([fixture(1)], "v1:2", 2), page([fixture(2)], "", 2),
    ]);
    const createRun = spyOn(repository, "createRun");

    const result = await collector.collect({ profile: "all", offerType: [2], delayMs: 0 });

    expect(result.status).toBe("completed");
    expect(listOffers).toHaveBeenCalledTimes(2);
    for (const [query] of listOffers.mock.calls) {
      expect(query).toMatchObject({ offerType: [2], promotionList: [], order: 1 });
      expect(query).not.toHaveProperty("offerTypeList");
      expect(query).not.toHaveProperty("destinationCountry");
    }
    expect(createRun.mock.calls[0]?.[0].query).toMatchObject({ offerType: [2] });
  });

  test("retains a verified provider partition across pagination and stores it in the run query", async () => {
    const { collector, repository, listOffers } = setup([
      page([fixture(1)], "provider-cursor", 2), page([fixture(2)], "", 2),
    ]);
    const createRun = spyOn(repository, "createRun");

    const result = await collector.collect({
      profile: "all", destinationCountry: [16], transportType: [1], providerList: [17], delayMs: 0,
    });

    expect(result.status).toBe("completed");
    expect(listOffers).toHaveBeenCalledTimes(2);
    for (const [query] of listOffers.mock.calls) {
      expect(query).toMatchObject({ destinationCountry: [16], transportType: [1], providerList: [17] });
    }
    expect(createRun.mock.calls[0]?.[0].query).toMatchObject({ providerList: [17] });
  });

  test("ends on an empty page without following a cursor that contains no offers", async () => {
    const { collector, repository, listOffers } = setup([page([], "unused-cursor", 0)]);

    const result = await collector.collect({ profile: "last-minute", delayMs: 0 });

    expect(result).toMatchObject({
      status: "completed", stopReason: "empty-page", pages: 1, received: 0, inserted: 0,
    });
    expect(listOffers).toHaveBeenCalledTimes(1);
    expect(repository.getStats().observations).toBe(0);
  });

  test("retains a nonempty page but fails when pagination metadata is missing", async () => {
    const response = page([fixture(1)]);
    const withoutMeta: HttpResponse<OfferListing> = { ...response, data: { data: [fixture(1)] } };
    const { collector, repository, listOffers } = setup([withoutMeta]);
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({ profile: "last-minute", delayMs: 0 }))
      .rejects.toBeInstanceOf(TypeError);

    expect(repository.getStats().observations).toBe(1);
    expect(finish.mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed" });
    expect(listOffers).toHaveBeenCalledTimes(1);
  });

  test.each([
    { label: "empty metadata", meta: {} },
    { label: "a positive total exceeding received offers", meta: { count: 1, total: 10 } },
  ])("retains offers but rejects an omitted cursor with $label", async ({ meta }) => {
    const response = page([fixture(1)]);
    const withoutCursor: HttpResponse<OfferListing> = {
      ...response, data: { data: [fixture(1)], meta },
    };
    const { collector, repository, listOffers } = setup([withoutCursor]);
    const finish = spyOn(repository, "finishRun");

    await expect(collector.collect({ profile: "last-minute", delayMs: 0 }))
      .rejects.toBeInstanceOf(TypeError);

    expect(repository.getStats().observations).toBe(1);
    expect(finish.mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed", inserted: 1, received: 1 });
    expect(listOffers).toHaveBeenCalledTimes(1);
  });

  test("accepts an explicitly empty cursor as the end of a nonempty final page", async () => {
    const { collector, listOffers } = setup([page([fixture(1)], "", 1)]);

    const result = await collector.collect({ profile: "last-minute", delayMs: 0 });

    expect(result).toMatchObject({ status: "completed", stopReason: "end-cursor", inserted: 1 });
    expect(listOffers).toHaveBeenCalledTimes(1);
  });

  test.each([
    { pageSize: 0 },
    { pageSize: 501 },
    { pageSize: 101 },
    { pageSize: 1.5 },
    { delayMs: -1 },
    { delayMs: 2_147_483_648 },
    { maxPages: 0 },
    { maxPages: 1.5 },
  ])("rejects invalid options %j before creating a run or requesting data", async (options) => {
    const { collector, repository, listOffers } = setup([]);

    await expect(collector.collect({ profile: "last-minute", delayMs: 0, ...options }))
      .rejects.toBeInstanceOf(RangeError);

    expect(listOffers).not.toHaveBeenCalled();
    expect(repository.getStats().runs).toBe(0);
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { HttpError } from "../src/http/HttpError";
import type { HttpResponse } from "../src/http/types";
import { CountryOfferCollector } from "../src/offers/CountryOfferCollector";
import type { CountryCollectionFailure, CountryCollectionProgress, CountryCollectionResult } from "../src/offers/CountryOfferCollector";
import type { CollectionOptions, CollectionResult } from "../src/offers/OfferCollector";
import type { DestinationCountry, OfferListing, OfferListingOptions, TravelProvider } from "../src/services/WakacjeClient";
import { OfferRepository } from "../src/storage/OfferRepository";

const repositories = new Set<OfferRepository>();
const country: DestinationCountry = { id: 16, label: "Example country", iso2Code: "EX" };
const providerCatalog: readonly TravelProvider[] = [{ id: 17, label: "Example provider" }, { id: 45, label: "Another provider" }];

afterEach(() => {
  mock.restore();
  for (const repository of repositories) repository.close();
  repositories.clear();
});

function response<T>(data: T | undefined): HttpResponse<T> {
  return {
    data,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    url: "https://example.test/api/search/destinations",
  };
}

function result(options: CollectionOptions, overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    runId: crypto.randomUUID(),
    profile: options.profile,
    pages: 1,
    received: 1,
    uniqueSourceIds: overrides.received === 0 ? 0 : 1,
    inserted: 1,
    duplicates: 0,
    rejected: 0,
    reportedTotal: 1,
    status: "completed",
    stopReason: "end-cursor",
    ...overrides,
  };
}

function setup(
  catalog: readonly DestinationCountry[] | undefined = [country],
  implementation: (options: CollectionOptions) => Promise<CollectionResult> = async (options) => result(options),
) {
  const repository = new OfferRepository(":memory:");
  repositories.add(repository);
  const getDestinations = mock(async (_signal?: AbortSignal) => response(catalog));
  const getProviders = mock(async (_signal?: AbortSignal) => response(providerCatalog));
  const listOffers = mock(async (_options?: OfferListingOptions): Promise<HttpResponse<OfferListing>> => {
    throw new Error("Unexpected direct listing request in orchestration test");
  });
  const collect = mock(implementation);
  return {
    repository,
    getDestinations,
    getProviders,
    listOffers,
    collect,
    collector: new CountryOfferCollector({ getDestinations, getProviders, listOffers }, repository, { collect }),
  };
}

function httpError(status: number): HttpError {
  return new HttpError("GET", "https://example.test/api/search/listing", new Response(null, { status }), undefined);
}

describe("CountryOfferCollector", () => {
  test("collects every unique country, profile, and verified transport separately and sequentially", async () => {
    let active = false;
    const context = setup([country, { id: 20, label: "Other country", iso2Code: "OT" }], async (options) => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
      return result(options);
    });

    const summary = await context.collector.collect({ profiles: ["all", "last-minute", "all-inclusive"], delayMs: 0 });

    expect(summary.results).toHaveLength(18);
    expect(summary.skipped).toBe(0);
    const scopes = context.collect.mock.calls.map(([options]) => [options.destinationCountry, options.profile, options.transportType]);
    expect(scopes.slice(0, 4)).toEqual([
      [[16], "all", [1]], [[16], "all", [3]], [[16], "all", [4]], [[16], "last-minute", [1]],
    ]);
    expect(context.getDestinations).toHaveBeenCalledTimes(1);
    expect(context.listOffers).not.toHaveBeenCalled();
  });

  test("unions observed country IDs with the catalog and prefers the current catalog label", async () => {
    const context = setup();
    spyOn(context.repository, "getObservedDestinations").mockReturnValue([
      { ...country, label: "Historical label" }, { id: 30, label: "Observed country", iso2Code: null },
    ]);

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0 });

    expect(summary.results).toHaveLength(6);
    expect(summary.results.filter(({ countryId }) => countryId === 16).every(({ country: label }) => label === country.label)).toBe(true);
    expect(summary.results.some(({ countryId, country: label }) => countryId === 30 && label === "Observed country")).toBe(true);
  });

  test("deduplicates requested profiles and runs all first without mutating the options", async () => {
    const context = setup();
    const profiles = ["all-inclusive", "all", "all-inclusive"] as const;

    const summary = await context.collector.collect({ profiles, delayMs: 0 });

    expect(summary.results).toHaveLength(6);
    expect(context.collect.mock.calls[0]?.[0].profile).toBe("all");
    expect(profiles).toEqual(["all-inclusive", "all", "all-inclusive"]);
  });

  test("skips subset profiles only for the same country and transport with a proven empty all scope", async () => {
    const context = setup([country, { id: 20, label: "Other country", iso2Code: null }], async (options) => {
      return result(options, options.profile === "all" && options.destinationCountry?.[0] === 16 && options.transportType?.[0] === 3
        ? { received: 0, inserted: 0, reportedTotal: 0, stopReason: "empty-page" }
        : {});
    });

    const summary = await context.collector.collect({ profiles: ["all", "last-minute", "all-inclusive"], delayMs: 0 });

    expect(summary.skipped).toBe(2);
    expect(summary.results).toHaveLength(16);
    expect(context.collect.mock.calls.some(([options]) => options.profile !== "all"
      && options.destinationCountry?.[0] === 16 && options.transportType?.[0] === 3)).toBe(false);
  });

  test.each([
    { status: "limited", stopReason: "max-pages", received: 0, reportedTotal: 0 },
    { status: "limited", stopReason: "count-mismatch", received: 0, reportedTotal: 100 },
    { received: 0, reportedTotal: null },
  ] satisfies Partial<CollectionResult>[])("does not infer empty subsets from partial or unknown coverage %j", async (overrides) => {
    const context = setup([country], async (options) => result(options, options.profile === "all" ? overrides : {}));

    const summary = await context.collector.collect({ profiles: ["all", "last-minute", "all-inclusive"], delayMs: 0 });

    expect(summary.results).toHaveLength(9);
    expect(summary.skipped).toBe(0);
  });

  test("forwards page size, per-query limit, cancellation, and scope-aware callbacks", async () => {
    const progress: CountryCollectionProgress[] = [];
    const finished: CountryCollectionResult[] = [];
    const context = setup([country], async (options) => {
      const value = result(options);
      options.onProgress?.(value);
      return value;
    });
    const controller = new AbortController();

    const summary = await context.collector.collect({
      profiles: ["last-minute"], pageSize: 25, maxPages: 2, delayMs: 0, signal: controller.signal,
      onProgress: (value) => progress.push(value), onResult: (value) => finished.push(value),
    });

    expect(context.getDestinations.mock.calls[0]?.[0]).toBe(controller.signal);
    for (const [options] of context.collect.mock.calls) {
      expect(options).toMatchObject({ pageSize: 25, maxPages: 2, delayMs: 0, signal: controller.signal });
    }
    expect(progress).toHaveLength(3);
    expect(progress[0]).toMatchObject({ countryId: 16, country: country.label, transportType: 1, profile: "last-minute" });
    expect(finished).toEqual([...summary.results]);
  });

  test("stops immediately on a failed scope rather than reporting later scopes as complete", async () => {
    const failure = new Error("Scope failed");
    const context = setup([country], async () => { throw failure; });

    await expect(context.collector.collect({ profiles: ["all"], delayMs: 0 })).rejects.toBe(failure);
    expect(context.collect).toHaveBeenCalledTimes(1);
  });

  test.each([429, 500, 502, 503, 504])("partitions a failed base scope after HTTP %s and continues other scopes", async (status) => {
    const context = setup([country], async (options) => {
      if (options.transportType?.[0] === 1 && options.providerList === undefined) throw httpError(status);
      return result(options);
    });

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0 });

    expect(summary.failures).toEqual([]);
    expect(summary.results).toHaveLength(4);
    expect(context.collect.mock.calls.filter(([options]) => options.providerList !== undefined)
      .map(([options]) => options.providerList)).toEqual([[17], [45]]);
    expect(context.getProviders).toHaveBeenCalledTimes(1);
  });

  test("partitions an API window once while retaining each limited child result", async () => {
    const context = setup([country], async (options) => result(options, options.transportType?.[0] === 1
      ? { status: "limited", stopReason: "api-window", reportedTotal: 20_000 } : {}));

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0 });

    expect(summary.results).toHaveLength(5);
    expect(summary.results.filter(({ providerId }) => providerId !== undefined)).toHaveLength(2);
    expect(context.collect).toHaveBeenCalledTimes(5);
    expect(context.getProviders).toHaveBeenCalledTimes(1);
  });

  test("unions provider catalogs with observed IDs and caches the API lookup for multiple failing scopes", async () => {
    const context = setup([country], async (options) => {
      if (options.providerList === undefined && options.transportType?.[0] !== 4) throw httpError(500);
      return result(options);
    });
    spyOn(context.repository, "getObservedProviders").mockReturnValue([
      { id: 17, label: "Historical name" }, { id: 99, label: "Observed provider" },
    ]);

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0 });

    expect(context.getProviders).toHaveBeenCalledTimes(1);
    const childIds = context.collect.mock.calls.filter(([options]) => options.transportType?.[0] === 1
      && options.providerList !== undefined).map(([options]) => options.providerList?.[0]).sort();
    expect(childIds).toEqual([17, 45, 99]);
    expect(summary.failures).toEqual([]);
    expect(summary.results).toHaveLength(7);
  });

  test("records safe provider failures and continues the remaining providers and countries", async () => {
    const failures: CountryCollectionFailure[] = [];
    const context = setup([country, { id: 20, label: "Other country", iso2Code: null }], async (options) => {
      if (options.destinationCountry?.[0] === 16 && options.transportType?.[0] === 1) {
        if (options.providerList === undefined) throw httpError(500);
        if (options.providerList[0] === 17) throw httpError(503);
      }
      return result(options);
    });

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0, onFailure: (failure) => failures.push(failure) });

    expect(summary.failures).toEqual([{
      countryId: 16, country: country.label, transportType: 1, profile: "all", providerId: 17,
      status: 503, errorKind: "HTTP_503",
    }]);
    expect(failures).toEqual([...summary.failures]);
    expect(summary.results.some(({ countryId, transportType }) => countryId === 20 && transportType === 4)).toBe(true);
    expect(summary.results.some(({ countryId, providerId }) => countryId === 16 && providerId === 45)).toBe(true);
    expect(context.collect).toHaveBeenCalledTimes(8);
  });

  test("handles exhausted native timeouts without retrying a provider partition recursively", async () => {
    const context = setup([country], async (options) => {
      if (options.transportType?.[0] === 1 && options.providerList?.[0] !== 45) {
        throw new DOMException("not copied to failure reports", "TimeoutError");
      }
      return result(options);
    });

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0 });

    expect(summary.failures).toEqual([{
      countryId: 16, country: country.label, transportType: 1, profile: "all", providerId: 17, errorKind: "TimeoutError",
    }]);
    expect(context.collect).toHaveBeenCalledTimes(5);
  });

  test.each([401, 403])("propagates HTTP %s without provider fallback", async (status) => {
    const failure = httpError(status);
    const context = setup([country], async () => { throw failure; });

    await expect(context.collector.collect({ profiles: ["all"], delayMs: 0 })).rejects.toBe(failure);
    expect(context.collect).toHaveBeenCalledTimes(1);
    expect(context.getProviders).not.toHaveBeenCalled();
  });

  test("propagates a provider validation error instead of treating it as a server failure", async () => {
    const failure = new TypeError("Invalid provider listing");
    const context = setup([country], async (options) => {
      if (options.providerList === undefined) throw httpError(500);
      throw failure;
    });

    await expect(context.collector.collect({ profiles: ["all"], delayMs: 0 })).rejects.toBe(failure);
    expect(context.collect).toHaveBeenCalledTimes(2);
  });

  test("propagates cancellation inside a provider scope without continuing to another provider", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Stopped by caller", "AbortError");
    const failures: CountryCollectionFailure[] = [];
    const context = setup([country], async (options) => {
      if (options.providerList === undefined) throw httpError(500);
      controller.abort(reason);
      throw reason;
    });

    await expect(context.collector.collect({
      profiles: ["all"], delayMs: 0, signal: controller.signal, onFailure: (failure) => failures.push(failure),
    })).rejects.toBe(reason);
    expect(context.collect).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([]);
  });

  test("forwards cancellation and provider IDs through child progress and result callbacks", async () => {
    const events: CountryCollectionProgress[] = [];
    const finished: CountryCollectionResult[] = [];
    const context = setup([country], async (options) => {
      if (options.transportType?.[0] === 1 && options.providerList === undefined) throw httpError(500);
      const value = result(options);
      options.onProgress?.(value);
      return value;
    });
    const controller = new AbortController();

    await context.collector.collect({
      profiles: ["all"], delayMs: 0, signal: controller.signal,
      onProgress: (event) => events.push(event), onResult: (event) => finished.push(event),
    });

    expect(context.getProviders.mock.calls[0]?.[0]).toBe(controller.signal);
    expect(events.filter(({ providerId }) => providerId !== undefined).map(({ providerId }) => providerId)).toEqual([17, 45]);
    expect(finished.filter(({ providerId }) => providerId !== undefined)).toHaveLength(2);
  });

  test("keeps an unresolved base failure when no providers are available", async () => {
    const context = setup([country], async (options) => {
      if (options.transportType?.[0] === 1) throw httpError(500);
      return result(options);
    });
    context.getProviders.mockResolvedValue(response([]));

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0 });

    expect(summary.failures).toEqual([{
      countryId: 16, country: country.label, transportType: 1, profile: "all", status: 500, errorKind: "HTTP_500",
    }]);
    expect(summary.results).toHaveLength(2);
  });

  test("rejects a missing provider catalog instead of inventing a provider partition", async () => {
    const context = setup([country], async () => { throw httpError(500); });
    context.getProviders.mockResolvedValue(response<readonly TravelProvider[]>(undefined));

    await expect(context.collector.collect({ profiles: ["all"], delayMs: 0 })).rejects.toThrow("Missing provider catalog");
    expect(context.collect).toHaveBeenCalledTimes(1);
  });

  test("does not query historical checkpoints without an explicit resume timestamp", async () => {
    const context = setup();
    const checkpoints = spyOn(context.repository, "getCollectionCheckpoints");

    await context.collector.collect({ profiles: ["all"], delayMs: 0 });

    expect(checkpoints).not.toHaveBeenCalled();
  });

  test("resumes only exact profile, country, and transport checkpoint tuples", async () => {
    const context = setup();
    const checkpoints = spyOn(context.repository, "getCollectionCheckpoints").mockReturnValue([
      { profile: "all", countryId: 16, transportType: 1, empty: false },
      { profile: "last-minute", countryId: 16, transportType: 4, empty: false },
      { profile: "all", countryId: 30, transportType: 3, empty: false },
    ]);

    const summary = await context.collector.collect({
      profiles: ["all", "last-minute"], delayMs: 0, resumeSince: "2026-10-16T14:00:00+02:00",
    });

    expect(checkpoints).toHaveBeenCalledWith("2026-10-16T12:00:00.000Z");
    expect(summary.skipped).toBe(2);
    expect(summary.results).toHaveLength(4);
    expect(context.collect.mock.calls.some(([options]) => options.profile === "all" && options.transportType?.[0] === 1)).toBe(false);
    expect(context.collect.mock.calls.some(([options]) => options.profile === "last-minute" && options.transportType?.[0] === 4)).toBe(false);
  });

  test("uses an explicitly resumed empty all checkpoint to skip only its subset scopes", async () => {
    const context = setup();
    spyOn(context.repository, "getCollectionCheckpoints").mockReturnValue([
      { profile: "all", countryId: 16, transportType: 3, empty: true },
    ]);

    const summary = await context.collector.collect({
      profiles: ["all-inclusive"], delayMs: 0, resumeSince: "2026-10-16T00:00:00Z",
    });

    expect(summary.skipped).toBe(1);
    expect(summary.results.map(({ transportType }) => transportType)).toEqual([1, 4]);
  });

  test("does not mistake a provider-filtered checkpoint for an unfiltered base scope", async () => {
    const context = setup([country], async (options) => {
      if (options.providerList === undefined) throw httpError(500);
      return result(options);
    });
    spyOn(context.repository, "getCollectionCheckpoints").mockReturnValue([
      { profile: "all", countryId: 16, transportType: 1, providerId: 17, empty: false },
      { profile: "all", countryId: 16, transportType: 3, empty: false },
      { profile: "all", countryId: 16, transportType: 4, empty: false },
    ]);

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0, resumeSince: "2026-10-16T00:00:00Z" });

    expect(context.collect.mock.calls[0]?.[0].providerList).toBeUndefined();
    expect(context.collect.mock.calls[1]?.[0].providerList).toEqual([45]);
    expect(summary.skipped).toBe(3);
    expect(summary.results).toHaveLength(1);
  });

  test("avoids retrying a base scope when all current provider children are checkpointed", async () => {
    const context = setup();
    spyOn(context.repository, "getCollectionCheckpoints").mockReturnValue([
      { profile: "all", countryId: 16, transportType: 1, providerId: 17, empty: false },
      { profile: "all", countryId: 16, transportType: 1, providerId: 45, empty: false },
      { profile: "all", countryId: 16, transportType: 3, empty: false },
      { profile: "all", countryId: 16, transportType: 4, empty: false },
    ]);

    const summary = await context.collector.collect({ profiles: ["all"], delayMs: 0, resumeSince: "2026-10-16T00:00:00Z" });

    expect(context.collect).not.toHaveBeenCalled();
    expect(context.getProviders).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toBe(4);
    expect(summary.failures).toEqual([]);
  });

  test("an empty all-provider child can skip only that provider subset, not the base query", async () => {
    const context = setup([country], async (options) => {
      if (options.transportType?.[0] === 1 && options.providerList === undefined) throw httpError(500);
      return result(options);
    });
    spyOn(context.repository, "getCollectionCheckpoints").mockReturnValue([
      { profile: "all", countryId: 16, transportType: 1, providerId: 17, empty: true },
    ]);

    const summary = await context.collector.collect({ profiles: ["all-inclusive"], delayMs: 0, resumeSince: "2026-10-16T00:00:00Z" });

    expect(context.collect.mock.calls[0]?.[0].providerList).toBeUndefined();
    expect(summary.skipped).toBe(1);
    expect(summary.results.filter(({ providerId }) => providerId !== undefined).map(({ providerId }) => providerId)).toEqual([45]);
  });

  test("rejects missing catalog data even when observed destinations exist", async () => {
    const context = setup();
    context.getDestinations.mockResolvedValue(response<readonly DestinationCountry[]>(undefined));
    spyOn(context.repository, "getObservedDestinations").mockReturnValue([country]);

    await expect(context.collector.collect({ profiles: ["all"], delayMs: 0 })).rejects.toThrow("Missing destination catalog");
    expect(context.collect).not.toHaveBeenCalled();
  });

  test("rejects an entirely empty country union", async () => {
    const context = setup([]);

    await expect(context.collector.collect({ profiles: ["all"], delayMs: 0 })).rejects.toThrow("no destination countries");
    expect(context.collect).not.toHaveBeenCalled();
  });

  test("can use observed destinations when a valid catalog is empty", async () => {
    const context = setup([]);
    spyOn(context.repository, "getObservedDestinations").mockReturnValue([country]);

    expect((await context.collector.collect({ profiles: ["all"], delayMs: 0 })).results).toHaveLength(3);
  });

  test("preserves pre-aborted cancellation without any catalog request", async () => {
    const context = setup();
    const reason = new Error("Cancelled");
    const controller = new AbortController();
    controller.abort(reason);

    await expect(context.collector.collect({ profiles: ["all"], signal: controller.signal })).rejects.toBe(reason);
    expect(context.getDestinations).not.toHaveBeenCalled();
  });

  test("cancels the inter-scope delay before sending another request", async () => {
    const context = setup();
    const controller = new AbortController();
    const reason = new Error("Cancelled while waiting");
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const collection = context.collector.collect({
        profiles: ["all"], delayMs: 1_000, signal: controller.signal,
        onResult: () => { timer = setTimeout(() => controller.abort(reason), 5); },
      });
      await expect(collection).rejects.toMatchObject({ name: "AbortError", cause: reason });
      expect(context.collect).toHaveBeenCalledTimes(1);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  test("validates options before calling services", async () => {
    const context = setup();
    for (const invalid of [
      { profiles: [] }, { pageSize: 101 }, { delayMs: -1 }, { delayMs: 2_147_483_648 },
      { maxPages: 0 }, { resumeSince: "invalid timestamp" },
    ]) {
      await expect(context.collector.collect({ profiles: ["all"], ...invalid })).rejects.toBeInstanceOf(Error);
    }
    expect(context.getDestinations).not.toHaveBeenCalled();
  });
});

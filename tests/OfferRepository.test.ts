import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedOffer, OfferObservation, RunSummary, ScrapeProfile } from "../src/offers/types";
import { OfferRepository } from "../src/storage/OfferRepository";

const repositories = new Set<OfferRepository>();
const temporaryDirectories: string[] = [];
const startedAt = "2026-10-16T10:00:00.000Z";

function repository(path = ":memory:"): OfferRepository {
  const instance = new OfferRepository(path);
  repositories.add(instance);
  return instance;
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "wakacje-offer-repository-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "offers.sqlite");
}

function observation(overrides: Partial<NormalizedOffer> = {}, observedAt = startedAt): OfferObservation {
  const offer: NormalizedOffer = {
    snapshotKey: "snapshot-one",
    comparisonKey: "comparison-one",
    sourceId: 123,
    hotelId: 456,
    name: "Example Resort",
    country: "Egipt",
    countryCode: "EG",
    region: "Hurghada",
    departureId: 7,
    departure: "Warszawa",
    startDate: "2026-11-01",
    endDate: "2026-11-08",
    nights: 7,
    cateringId: 3,
    catering: "All inclusive",
    providerCode: "EX",
    provider: "Example Travel",
    roomId: "room-one",
    stars: 4.5,
    rating: 8.7,
    priceMinor: 250_099,
    currency: "PLN",
    priceType: "total",
    adults: 2,
    children: 0,
    sourceHash: "public-source-hash",
    ...overrides,
  };
  return {
    offer,
    observedAt,
    sourceUrl: "https://example.test/public/offers?page=1",
    rawJson: JSON.stringify({ id: offer.sourceId, name: offer.name, unmodeledFeature: ["public-value"] }),
  };
}

function run(instance: OfferRepository, profile: ScrapeProfile = "last-minute"): string {
  return instance.createRun({ profile, query: { pageSize: 100, adults: 2 }, startedAt });
}

function summary(status: RunSummary["status"] = "completed"): RunSummary {
  return { status, pages: 1, received: 1, inserted: 1, rejected: 0, finishedAt: "2026-10-16T10:05:00.000Z" };
}

function countryJson(id: unknown, name: unknown, iso2Code: unknown): string {
  return JSON.stringify({ localisation: { country: { id, name, iso2Code } } });
}

function scopeRun(
  instance: OfferRepository,
  query: Record<string, unknown>,
  overrides: Partial<RunSummary> = {},
  beganAt = startedAt,
  profile: ScrapeProfile = "all",
): string {
  const id = instance.createRun({ profile, query: {
    adultCount: 2,
    childCount: 0,
    promotionList: profile === "last-minute" ? [1] : [],
    ...(profile === "all-inclusive" ? { cateringList: [1] } : {}),
    ...query,
  }, startedAt: beganAt });
  instance.finishRun(id, { ...summary(), stopReason: "end-cursor", reportedTotal: 1, ...overrides });
  return id;
}

afterEach(() => {
  for (const instance of repositories) instance.close();
  repositories.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("OfferRepository", () => {
  test("round-trips every normalized scalar alongside the exact public JSON", () => {
    const instance = repository();
    expect(instance.getStats()).toEqual({ runs: 0, observations: 0, comparisonGroups: 0, rejected: 0 });
    const runId = run(instance);
    const item = observation();
    expect(instance.savePage(runId, [item])).toEqual({ inserted: 1, duplicates: 0 });
    expect(instance.getLatest()).toEqual([{ ...item, id: 1, runId, profile: "last-minute" }]);
    instance.finishRun(runId, summary());
    expect(instance.getStats()).toEqual({ runs: 1, observations: 1, comparisonGroups: 1, rejected: 0 });
  });

  test("deduplicates snapshots within a run while retaining observations across runs", () => {
    const instance = repository();
    const firstRun = run(instance);
    expect(instance.savePage(firstRun, [observation(), observation()])).toEqual({ inserted: 1, duplicates: 1 });
    expect(instance.savePage(firstRun, [observation()])).toEqual({ inserted: 0, duplicates: 1 });
    instance.finishRun(firstRun, summary());
    const secondRun = run(instance);
    expect(instance.savePage(secondRun, [observation()])).toEqual({ inserted: 1, duplicates: 0 });
    expect(instance.getStats()).toEqual({ runs: 2, observations: 2, comparisonGroups: 1, rejected: 0 });
    expect(instance.getLatest()[0]?.runId).toBe(secondRun);
  });

  test("chooses the most recent observation before sorting groups by current price", () => {
    const instance = repository();
    const firstRun = run(instance);
    instance.savePage(firstRun, [observation({ priceMinor: 100_000 })]);
    instance.finishRun(firstRun, summary());
    const nextRun = run(instance, "all-inclusive");
    instance.savePage(nextRun, [
      observation({ snapshotKey: "new-snapshot", priceMinor: 300_000 }, "2026-10-16T11:00:00.000Z"),
      observation({ snapshotKey: "second-group", comparisonKey: "comparison-two", priceMinor: 200_000 }),
    ]);

    expect(instance.getLatest().map((item) => item.offer.priceMinor)).toEqual([200_000, 300_000]);
    expect(instance.getLatest("last-minute").map((item) => item.offer.priceMinor)).toEqual([100_000]);
    expect(instance.getLatest("all-inclusive").map((item) => item.runId)).toEqual([nextRun, nextRun]);
  });

  test("normalizes timezone offsets so chronological order is independent of input formatting", () => {
    const instance = repository();
    const runId = run(instance);
    instance.savePage(runId, [
      observation({ snapshotKey: "newer" }, "2026-10-16T11:00:00Z"),
      observation({ snapshotKey: "older" }, "2026-10-16T12:00:00+02:00"),
    ]);
    expect(instance.getLatest()[0]?.offer.snapshotKey).toBe("newer");
    expect(instance.getLatest()[0]?.observedAt).toBe("2026-10-16T11:00:00.000Z");
  });

  test("stores the unfiltered all profile independently of filtered observations", () => {
    const instance = repository();
    const allRun = run(instance, "all");
    instance.savePage(allRun, [observation()]);
    expect(instance.getLatest("all")[0]?.profile).toBe("all");
    expect(instance.getLatest("last-minute")).toEqual([]);
  });

  test.each(["completed", "limited", "failed"] as const)("retains partial observations after a %s run", (status) => {
    const instance = repository();
    const runId = run(instance);
    instance.savePage(runId, [observation({ roomId: null, stars: null, rating: null })]);
    instance.finishRun(runId, summary(status));
    expect(instance.getLatest()[0]?.offer).toMatchObject({ roomId: null, stars: null, rating: null });
    expect(instance.getStats().observations).toBe(1);
  });

  test("refuses unknown runs, final status changes, and appending to finalized runs", () => {
    const instance = repository();
    expect(() => instance.savePage("missing", [observation()])).toThrow();
    expect(() => instance.finishRun("missing", summary())).toThrow();
    const runId = run(instance);
    instance.finishRun(runId, summary("limited"));
    expect(() => instance.finishRun(runId, summary("completed"))).toThrow();
    expect(() => instance.savePage(runId, [observation()])).toThrow();
    expect(instance.getStats().observations).toBe(0);
  });

  test("rolls back a page when a later record violates a non-unique constraint", () => {
    const instance = repository();
    const runId = run(instance);
    const malformed = { ...observation({ snapshotKey: "bad" }), rawJson: "{invalid-json" };
    expect(() => instance.savePage(runId, [observation(), malformed])).toThrow();
    expect(instance.getStats().observations).toBe(0);
    expect(instance.savePage(runId, [observation()])).toEqual({ inserted: 1, duplicates: 0 });
  });

  test.each([Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects unsafe minor-unit prices (%s) without committing preceding rows",
    (priceMinor) => {
      const instance = repository();
      const runId = run(instance);
      expect(() => instance.savePage(runId, [
        observation(), observation({ snapshotKey: "unsafe-price", priceMinor }),
      ])).toThrow(TypeError);
      expect(instance.getStats().observations).toBe(0);
    },
  );

  test("preserves the largest safe integer price exactly", () => {
    const instance = repository();
    instance.savePage(run(instance), [observation({ priceMinor: Number.MAX_SAFE_INTEGER })]);
    expect(instance.getLatest()[0]?.offer.priceMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("persists data, run parameters, and final summaries across close and reopen", () => {
    const path = databasePath();
    const original = repository(path);
    const runId = original.createRun({ profile: "all-inclusive", query: { catering: [1, 3] }, startedAt });
    original.savePage(runId, [observation()]);
    original.finishRun(runId, { ...summary("failed"), errorKind: "HTTP_503" });
    original.close();
    repositories.delete(original);

    const reopened = repository(path);
    expect(reopened.getLatest()[0]?.runId).toBe(runId);
    expect(reopened.getLatest()[0]?.profile).toBe("all-inclusive");
    const inspection = new Database(path, { readonly: true });
    try {
      expect(inspection.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(inspection.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(inspection.query("SELECT query_json, status, error_kind FROM scrape_runs WHERE id = ?").get(runId))
        .toEqual({ query_json: '{"catering":[1,3]}', status: "failed", error_kind: "HTTP_503" });
    } finally {
      inspection.close();
    }
  });

  test("binds SQL-looking public strings as data", () => {
    const instance = repository();
    const item = observation({ name: "Resort '); DROP TABLE scrape_runs; --" });
    const runId = instance.createRun({ profile: "last-minute", query: { text: item.offer.name }, startedAt });
    instance.savePage(runId, [item]);
    expect(instance.getLatest()[0]?.offer.name).toBe(item.offer.name);
    expect(instance.getStats().runs).toBe(1);
  });

  test("rejects non-serializable run queries before creating a run", () => {
    const instance = repository();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const query of [undefined, circular, 1n]) {
      expect(() => instance.createRun({ profile: "last-minute", query, startedAt })).toThrow(TypeError);
    }
    expect(instance.getStats().runs).toBe(0);
  });

  test("rejects invalid observation timestamps atomically", () => {
    const instance = repository();
    const runId = run(instance);
    expect(() => instance.savePage(runId, [observation(), observation({ snapshotKey: "invalid-date" }, "invalid")]))
      .toThrow(TypeError);
    expect(instance.getStats().observations).toBe(0);
  });

  test("refuses to open an unsupported future schema version", () => {
    const path = databasePath();
    const instance = repository(path);
    instance.close();
    repositories.delete(instance);
    const future = new Database(path);
    future.run("PRAGMA user_version = 4");
    future.close();
    expect(() => repository(path)).toThrow("Unsupported offers database schema version");
  });

  test("quarantines exact rejected JSON, ignores repeated page indexes, and rejects final runs", () => {
    const path = databasePath();
    const instance = repository(path);
    const runId = run(instance);
    const rawJson = '{ "unknownApiField": { "nested": true }, "price": null }';
    const rejected = { page: 2, itemIndex: 5, observedAt: startedAt, rawJson, reason: "Missing price field" };
    expect(instance.saveRejected(runId, [rejected, rejected])).toBe(1);
    expect(instance.saveRejected(runId, [rejected])).toBe(0);
    expect(instance.getStats()).toEqual({ runs: 1, observations: 0, comparisonGroups: 0, rejected: 1 });
    const inspection = new Database(path, { readonly: true });
    try {
      expect(inspection.query("SELECT page, item_index, observed_at, raw_json, reason FROM rejected_offers").get())
        .toEqual({ page: 2, item_index: 5, observed_at: startedAt, raw_json: rawJson, reason: rejected.reason });
    } finally {
      inspection.close();
    }
    instance.finishRun(runId, { ...summary(), rejected: 1, inserted: 0 });
    expect(() => instance.saveRejected(runId, [rejected])).toThrow();
    expect(() => instance.saveRejected("unknown", [rejected])).toThrow();
  });

  test("rolls back rejected rows when a later quarantine record is malformed", () => {
    const instance = repository();
    const runId = run(instance);
    const item = { page: 1, itemIndex: 0, observedAt: startedAt, rawJson: "{}", reason: "Missing field" };
    expect(() => instance.saveRejected(runId, [item, { ...item, itemIndex: 1, rawJson: "{" }])).toThrow();
    expect(instance.getStats().rejected).toBe(0);
  });

  test("migrates populated version-one databases and repairs finalized runs without rewriting ingestion history", () => {
    const path = databasePath();
    const original = repository(path);
    const runId = run(original, "all");
    const valid = observation();
    const recoverable = observation({ snapshotKey: "six-star-snapshot", comparisonKey: "six-star-group", stars: 6 });
    const rawJson = '{ "id": 987, "category": 6, "unmodeled": "retained" }';
    original.savePage(runId, [valid]);
    original.saveRejected(runId, [{ page: 1, itemIndex: 1, observedAt: startedAt, rawJson, reason: "Invalid category" }]);
    original.finishRun(runId, { ...summary(), received: 2, inserted: 1, rejected: 1 });
    original.close();
    repositories.delete(original);

    // Reconstruct the actual v1 schema while retaining existing normalized and quarantined data.
    const previousVersion = new Database(path);
    previousVersion.run("ALTER TABLE rejected_offers DROP COLUMN resolved_at");
    previousVersion.run("ALTER TABLE scrape_runs DROP COLUMN reported_total");
    previousVersion.run("ALTER TABLE scrape_runs DROP COLUMN stop_reason");
    previousVersion.run("PRAGMA user_version = 1");
    previousVersion.close();

    const migrated = repository(path);
    const rejected = migrated.getRejected()[0];
    expect(rejected).toEqual({ id: 1, runId, observedAt: startedAt, rawJson, sourceUrl: valid.sourceUrl });
    expect(migrated.getStats()).toEqual({ runs: 1, observations: 1, comparisonGroups: 1, rejected: 1 });
    const repair = { ...recoverable, rawJson };
    expect(migrated.recoverRejected(1, repair)).toBe(true);
    expect(migrated.recoverRejected(1, repair)).toBe(false);
    expect(migrated.getRejected()).toEqual([]);
    expect(migrated.getStats()).toEqual({ runs: 1, observations: 2, comparisonGroups: 2, rejected: 0 });
    expect(migrated.getLatest("all").find(({ offer }) => offer.stars === 6))
      .toMatchObject({ runId, profile: "all", observedAt: startedAt, rawJson });
    expect(() => migrated.savePage(runId, [observation({ snapshotKey: "still-finalized" })])).toThrow();

    const inspection = new Database(path, { readonly: true });
    try {
      expect(inspection.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(inspection.query("SELECT raw_json, reason, resolved_at FROM rejected_offers WHERE id = 1").get())
        .toEqual({ raw_json: rawJson, reason: "Invalid category", resolved_at: expect.any(String) });
      expect(inspection.query("SELECT status, received, inserted, rejected FROM scrape_runs WHERE id = ?").get(runId))
        .toEqual({ status: "completed", received: 2, inserted: 1, rejected: 1 });
    } finally {
      inspection.close();
    }
  });

  test("recovery uses the verified listing fallback for wholly rejected pages and accepts equivalent timestamps", () => {
    const instance = repository();
    const runId = run(instance);
    const item = observation({ stars: 5.5 });
    instance.saveRejected(runId, [{ page: 1, itemIndex: 0, observedAt: startedAt, rawJson: item.rawJson, reason: "Invalid stars" }]);
    instance.finishRun(runId, { ...summary("limited"), inserted: 0, rejected: 1 });
    const rejected = instance.getRejected()[0];
    expect(rejected?.sourceUrl).toBe("https://thor.wakacje.pl/api/v1/wak-logic/search/listing");
    expect(instance.recoverRejected(1, {
      ...item, observedAt: "2026-10-16T12:00:00+02:00", sourceUrl: rejected?.sourceUrl ?? "",
    })).toBe(true);
    expect(instance.getLatest()[0]?.observedAt).toBe(startedAt);
    expect(instance.getLatest()[0]?.offer.stars).toBe(5.5);
  });

  test("recovery rejects changed source data, changed times, and invalid scalars atomically", () => {
    const instance = repository();
    const runId = run(instance);
    const item = observation();
    instance.saveRejected(runId, [{ page: 1, itemIndex: 0, observedAt: startedAt, rawJson: item.rawJson, reason: "Invalid field" }]);
    instance.finishRun(runId, { ...summary("failed"), inserted: 0, rejected: 1 });
    for (const invalid of [
      { ...item, rawJson: "{}" },
      { ...item, observedAt: "2026-10-16T10:00:01Z" },
      { ...item, offer: { ...item.offer, priceMinor: Number.NaN } },
    ]) {
      expect(() => instance.recoverRejected(1, invalid)).toThrow(TypeError);
      expect(instance.getStats()).toEqual({ runs: 1, observations: 0, comparisonGroups: 0, rejected: 1 });
      expect(instance.getRejected()).toHaveLength(1);
    }
    expect(instance.recoverRejected(999, item)).toBe(false);
  });

  test("recovery resolves an existing snapshot without replacing the stored observation", () => {
    const instance = repository();
    const runId = run(instance);
    const item = observation();
    instance.savePage(runId, [item]);
    instance.saveRejected(runId, [{ page: 2, itemIndex: 0, observedAt: startedAt, rawJson: item.rawJson, reason: "Old parser error" }]);
    instance.finishRun(runId, { ...summary(), received: 2, rejected: 1 });
    expect(instance.recoverRejected(1, { ...item, offer: { ...item.offer, priceMinor: 1 } })).toBe(true);
    expect(instance.getStats()).toEqual({ runs: 1, observations: 1, comparisonGroups: 1, rejected: 0 });
    expect(instance.getLatest()[0]?.offer.priceMinor).toBe(item.offer.priceMinor);
  });

  test("persists reported totals and termination evidence without treating a terminal cursor as full coverage", () => {
    const path = databasePath();
    const instance = repository(path);
    const runId = run(instance);
    instance.savePage(runId, [observation()]);
    instance.finishRun(runId, { ...summary(), reportedTotal: 10_000, stopReason: "end-cursor" });
    const inspection = new Database(path, { readonly: true });
    try {
      expect(inspection.query("SELECT status, received, reported_total, stop_reason FROM scrape_runs WHERE id = ?").get(runId))
        .toEqual({ status: "completed", received: 1, reported_total: 10_000, stop_reason: "end-cursor" });
    } finally {
      inspection.close();
    }
  });

  test("preserves unknown totals as null while keeping explicit zero totals", () => {
    const path = databasePath();
    const instance = repository(path);
    for (const evidence of [{}, { reportedTotal: null }, { reportedTotal: 0, stopReason: "empty-page" }]) {
      instance.finishRun(run(instance), { ...summary(), ...evidence });
    }
    const inspection = new Database(path, { readonly: true });
    try {
      expect(inspection.query("SELECT reported_total, stop_reason FROM scrape_runs ORDER BY rowid").all())
        .toEqual([
          { reported_total: null, stop_reason: null },
          { reported_total: null, stop_reason: null },
          { reported_total: 0, stop_reason: "empty-page" },
        ]);
    } finally {
      inspection.close();
    }
  });

  test("rejects invalid coverage evidence without finalizing the run", () => {
    const instance = repository();
    const runId = run(instance);
    for (const reportedTotal of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => instance.finishRun(runId, { ...summary(), reportedTotal })).toThrow(TypeError);
    }
    expect(() => instance.finishRun(runId, { ...summary(), stopReason: " " })).toThrow(TypeError);
    expect(instance.savePage(runId, [observation()])).toEqual({ inserted: 1, duplicates: 0 });
  });

  test("migrates populated version-two databases while an older writer retains prepared statements", () => {
    const path = databasePath();
    const original = repository(path);
    const runId = run(original);
    original.savePage(runId, [observation()]);
    original.saveRejected(runId, [{ page: 1, itemIndex: 1, observedAt: startedAt, rawJson: "{}", reason: "Missing field" }]);
    original.close();
    repositories.delete(original);

    const oldWriter = new Database(path);
    try {
      oldWriter.run("ALTER TABLE scrape_runs DROP COLUMN reported_total");
      oldWriter.run("ALTER TABLE scrape_runs DROP COLUMN stop_reason");
      oldWriter.run("PRAGMA user_version = 2");
      const insertLegacy = oldWriter.query(`
        INSERT INTO rejected_offers (run_id, page, item_index, observed_at, raw_json, reason)
        VALUES (?, 2, 0, ?, '{}', 'Missing field')
      `);
      const finishLegacy = oldWriter.query(`
        UPDATE scrape_runs SET status = 'completed', received = 3, inserted = 1, rejected = 2,
          finished_at = ? WHERE id = ?
      `);

      const migrated = repository(path);
      insertLegacy.run(runId, startedAt);
      finishLegacy.run(summary().finishedAt, runId);
      expect(migrated.getStats()).toEqual({ runs: 1, observations: 1, comparisonGroups: 1, rejected: 2 });
      expect(migrated.getRejected()).toHaveLength(2);
      expect(oldWriter.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(oldWriter.query("SELECT reported_total, stop_reason FROM scrape_runs WHERE id = ?").get(runId))
        .toEqual({ reported_total: null, stop_reason: null });

      const nextRun = run(migrated);
      migrated.finishRun(nextRun, { ...summary("limited"), reportedTotal: 55, stopReason: "max-pages" });
      expect(oldWriter.query("SELECT reported_total, stop_reason FROM scrape_runs WHERE id = ?").get(nextRun))
        .toEqual({ reported_total: 55, stop_reason: "max-pages" });
    } finally {
      oldWriter.close();
    }
  });

  test("discovers destinations from both normalized and quarantined public JSON", () => {
    const instance = repository();
    const runId = run(instance, "all");
    instance.savePage(runId, [
      { ...observation({ snapshotKey: "ethiopia-incomplete-code" }), rawJson: countryJson(419, "Ethiopia", null) },
      { ...observation({ snapshotKey: "ethiopia-valid-code" }), rawJson: countryJson(419, "Etiopia", "ET") },
      { ...observation({ snapshotKey: "nepal" }), rawJson: countryJson(49, "Nepal", "NP") },
    ]);
    const rawJson = countryJson(335, "Kirgistan", "KG");
    instance.saveRejected(runId, [{ page: 1, itemIndex: 3, observedAt: startedAt, rawJson, reason: "Invalid field" }]);
    expect(instance.getObservedDestinations()).toEqual([
      { id: 49, label: "Nepal", iso2Code: "NP" },
      { id: 335, label: "Kirgistan", iso2Code: "KG" },
      { id: 419, label: "Etiopia", iso2Code: "ET" },
    ]);

    // Resolved source evidence remains available for later destination discovery.
    instance.recoverRejected(1, { ...observation({ snapshotKey: "recovered-kyrgyzstan" }), rawJson });
    expect(instance.getObservedDestinations()).toHaveLength(3);
  });

  test("validates destination JSON types and keeps unknown or invalid ISO codes null", () => {
    const instance = repository();
    const runId = run(instance);
    const sources = [
      countryJson(0, "Zero", "ZZ"),
      countryJson(-1, "Negative", "ZZ"),
      countryJson(1.5, "Fractional", "ZZ"),
      countryJson(true, "Boolean", "ZZ"),
      countryJson("419", "String identifier", "ZZ"),
      countryJson(Number.MAX_SAFE_INTEGER + 1, "Unsafe identifier", "ZZ"),
      countryJson(500, " \t\n", "ZZ"),
      countryJson(501, { label: "Object" }, "ZZ"),
      countryJson(502, ["Array"], "ZZ"),
      countryJson(49, " Nepal ", "np"),
      countryJson(335, "Kirgistan", "KGG"),
      "null",
    ];
    instance.saveRejected(runId, sources.map((rawJson, itemIndex) => ({
      page: 1, itemIndex, observedAt: startedAt, rawJson, reason: "Invalid field",
    })));
    expect(instance.getObservedDestinations()).toEqual([
      { id: 49, label: "Nepal", iso2Code: null },
      { id: 335, label: "Kirgistan", iso2Code: null },
    ]);
  });

  test("selects destination labels deterministically regardless of insertion order", () => {
    const sources = [
      countryJson(419, "0 missing ISO", null),
      countryJson(419, "B valid label", "ET"),
      countryJson(419, "A valid label", "ET"),
    ];
    for (const ordered of [sources, [...sources].reverse()]) {
      const instance = repository();
      const runId = run(instance);
      instance.saveRejected(runId, ordered.map((rawJson, itemIndex) => ({
        page: 1, itemIndex, observedAt: startedAt, rawJson, reason: "Invalid field",
      })));
      expect(instance.getObservedDestinations()).toEqual([{ id: 419, label: "A valid label", iso2Code: "ET" }]);
    }
  });

  test("reads explicit sorted batch checkpoints for completed and consumed limited scopes", () => {
    const instance = repository();
    scopeRun(instance, { destinationCountry: [16], transportType: [1], order: 1 }, {
      stopReason: "empty-page", received: 0, inserted: 0, reportedTotal: 0,
    });
    scopeRun(instance, { destinationCountry: [16], transportType: [3], order: 1 }, {
      status: "limited", stopReason: "count-mismatch", received: 2, reportedTotal: 4,
    }, startedAt, "last-minute");
    scopeRun(instance, { destinationCountry: [49], transportType: [4], order: 1 }, {
      status: "limited", stopReason: "count-mismatch", received: 4, reportedTotal: 4,
    }, startedAt, "all-inclusive");
    expect(instance.getCollectionCheckpoints("2026-10-16T12:00:00+02:00")).toEqual([
      { profile: "all", countryId: 16, transportType: 1, empty: true },
      { profile: "all-inclusive", countryId: 49, transportType: 4, empty: false },
      { profile: "last-minute", countryId: 16, transportType: 3, empty: false },
    ]);
  });

  test("uses only the newest eligible checkpoint in the requested batch", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    scopeRun(instance, query, {}, "2026-10-15T10:00:00Z");
    expect(instance.getCollectionCheckpoints(startedAt)).toEqual([]);
    scopeRun(instance, query, { received: 0, inserted: 0, reportedTotal: 0 }, startedAt);
    scopeRun(instance, query, {}, "2026-10-16T10:01:00Z");
    expect(instance.getCollectionCheckpoints(startedAt)).toEqual([
      { profile: "all", countryId: 16, transportType: 1, empty: false },
    ]);
  });

  test("breaks same-time checkpoint ties deterministically using the run ID", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    const emptyId = scopeRun(instance, query, { received: 0, inserted: 0, reportedTotal: 0 });
    const nonemptyId = scopeRun(instance, query);
    expect(instance.getCollectionCheckpoints(startedAt)[0]?.empty).toBe(emptyId > nonemptyId);
  });

  test("excludes broad, unordered, ambiguous, invalid, failed, and unfinished scopes from resume", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    for (const invalid of [
      {},
      { ...query, destinationCountry: [] },
      { ...query, destinationCountry: [16, 49] },
      { ...query, destinationCountry: ["16"] },
      { ...query, destinationCountry: [true] },
      { ...query, destinationCountry: [0] },
      { ...query, destinationCountry: [-1] },
      { ...query, destinationCountry: [Number.MAX_SAFE_INTEGER + 1] },
      { ...query, transportType: [] },
      { ...query, transportType: [1, 3] },
      { ...query, transportType: [2] },
      { ...query, transportType: [true] },
      { destinationCountry: [16], transportType: [1] },
      { ...query, order: 0 },
      { ...query, order: "1" },
      { ...query, order: true },
    ]) scopeRun(instance, invalid);
    scopeRun(instance, query, { status: "failed" });
    scopeRun(instance, query, { status: "limited", stopReason: "max-pages" });
    instance.createRun({ profile: "all", query, startedAt });
    expect(instance.getCollectionCheckpoints(startedAt)).toEqual([]);
  });

  test("marks a checkpoint empty only when a completed run explicitly reported zero results", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    scopeRun(instance, query, { received: 0, inserted: 0, reportedTotal: null });
    scopeRun(instance, { ...query, transportType: [3] }, {
      status: "limited", stopReason: "count-mismatch", received: 0, inserted: 0, reportedTotal: 0,
    });
    scopeRun(instance, { ...query, transportType: [4] }, { received: 1, reportedTotal: 0 });
    expect(instance.getCollectionCheckpoints(startedAt).map(({ empty }) => empty)).toEqual([false, false, false]);
  });

  test("rejects invalid batch timestamps without changing stored data", () => {
    const instance = repository();
    for (const since of ["", "invalid", "2026-99-99T00:00:00Z"]) {
      expect(() => instance.getCollectionCheckpoints(since)).toThrow(TypeError);
    }
    expect(instance.getStats()).toEqual({ runs: 0, observations: 0, comparisonGroups: 0, rejected: 0 });
  });

  test("keeps provider child checkpoints separate from the whole country and transport scope", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    scopeRun(instance, query);
    scopeRun(instance, { ...query, providerList: [5] }, {
      received: 0, inserted: 0, reportedTotal: 0, stopReason: "empty-page",
    }, "2026-10-16T10:01:00Z");
    scopeRun(instance, { ...query, providerList: [6] }, {
      status: "limited", stopReason: "count-mismatch",
    });
    const checkpoints = instance.getCollectionCheckpoints(startedAt);
    expect(checkpoints).toEqual([
      { profile: "all", countryId: 16, transportType: 1, empty: false },
      { profile: "all", countryId: 16, transportType: 1, providerId: 5, empty: true },
      { profile: "all", countryId: 16, transportType: 1, providerId: 6, empty: false },
    ]);
    expect(Object.hasOwn(checkpoints[0] ?? {}, "providerId")).toBe(false);
  });

  test("retries base API windows on resume while retaining consumed provider windows", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    scopeRun(instance, query, { status: "limited", stopReason: "api-window" });
    scopeRun(instance, { ...query, providerList: [5] }, { status: "limited", stopReason: "api-window" });
    expect(instance.getCollectionCheckpoints(startedAt)).toEqual([
      { profile: "all", countryId: 16, transportType: 1, providerId: 5, empty: false },
    ]);
  });

  test("excludes malformed provider filters instead of treating them as base scopes", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    for (const providerList of [[], [5, 6], [0], [-1], [1.5], [true], ["5"], [Number.MAX_SAFE_INTEGER + 1], null, 5]) {
      scopeRun(instance, { ...query, providerList });
    }
    expect(instance.getCollectionCheckpoints(startedAt)).toEqual([]);
  });

  test("requires the exact party and profile filters before resuming a country scope", () => {
    const instance = repository();
    const query = { destinationCountry: [16], transportType: [1], order: 1 };
    for (const invalid of [
      { adultCount: undefined }, { adultCount: 1 }, { adultCount: "2" }, { adultCount: true },
      { childCount: undefined }, { childCount: 1 }, { childCount: "0" }, { childCount: false },
      { promotionList: undefined }, { promotionList: null }, { promotionList: [1] },
      { cateringList: [] }, { cateringList: null }, { cateringList: [1] },
      { offerType: 1 }, { offerType: null },
    ]) scopeRun(instance, { ...query, ...invalid });
    for (const promotionList of [undefined, [], [2], ["1"], [true], [1, 2]]) {
      scopeRun(instance, { ...query, promotionList }, {}, startedAt, "last-minute");
    }
    scopeRun(instance, { ...query, cateringList: [1] }, {}, startedAt, "last-minute");
    for (const cateringList of [undefined, null, [], [2], ["1"], [true], [1, 2]]) {
      scopeRun(instance, { ...query, cateringList }, {}, startedAt, "all-inclusive");
    }
    scopeRun(instance, { ...query, promotionList: [1] }, {}, startedAt, "all-inclusive");
    expect(instance.getCollectionCheckpoints(startedAt)).toEqual([]);
  });

  test("discovers and deduplicates providers from all retained public source JSON", () => {
    const instance = repository();
    const runId = run(instance);
    instance.savePage(runId, [
      { ...observation({ snapshotKey: "provider-seven" }), rawJson: '{"provider":{"id":7,"label":" B Travel "}}' },
      { ...observation({ snapshotKey: "provider-seven-again" }), rawJson: '{"provider":{"id":7,"label":"A Travel"}}' },
    ]);
    const rawJson = '{"provider":{"id":9,"label":"Nine Travel"}}';
    instance.saveRejected(runId, [{ page: 1, itemIndex: 0, observedAt: startedAt, rawJson, reason: "Old parser error" }]);
    expect(instance.getObservedProviders()).toEqual([{ id: 7, label: "A Travel" }, { id: 9, label: "Nine Travel" }]);
    // A resolved row still contributes evidence when its normalized snapshot already existed.
    instance.recoverRejected(1, { ...observation({ snapshotKey: "provider-seven" }), rawJson });
    expect(instance.getObservedProviders()).toEqual([{ id: 7, label: "A Travel" }, { id: 9, label: "Nine Travel" }]);
  });

  test("ignores invalid provider identifiers and non-string or empty source labels", () => {
    const instance = repository();
    const runId = run(instance);
    const providers = [
      { id: 0, label: "Zero" }, { id: -1, label: "Negative" }, { id: 1.5, label: "Fractional" },
      { id: true, label: "Boolean" }, { id: "7", label: "String ID" },
      { id: Number.MAX_SAFE_INTEGER + 1, label: "Unsafe ID" },
      { id: 7, label: " \t\n" }, { id: 7, label: ["Array"] }, { id: 7, label: { text: "Object" } },
    ];
    instance.saveRejected(runId, providers.map((provider, itemIndex) => ({
      page: 1, itemIndex, observedAt: startedAt, rawJson: JSON.stringify({ provider }), reason: "Invalid field",
    })));
    expect(instance.getObservedProviders()).toEqual([]);
  });
});

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  NormalizedOffer,
  OfferObservation,
  RepositoryStats,
  RunStatus,
  RunSummary,
  ScrapeProfile,
  StoredOffer,
} from "../offers/types";

const offerColumns = {
  snapshotKey: "snapshot_key",
  comparisonKey: "comparison_key",
  sourceId: "source_id",
  hotelId: "hotel_id",
  name: "name",
  country: "country",
  countryCode: "country_code",
  region: "region",
  departureId: "departure_id",
  departure: "departure",
  startDate: "start_date",
  endDate: "end_date",
  nights: "nights",
  cateringId: "catering_id",
  catering: "catering",
  providerCode: "provider_code",
  provider: "provider",
  roomId: "room_id",
  stars: "stars",
  rating: "rating",
  priceMinor: "price_minor",
  currency: "currency",
  priceType: "price_type",
  adults: "adults",
  children: "children",
  sourceHash: "source_hash",
} as const satisfies Record<keyof NormalizedOffer, string>;

const insertObservationSql = `
  INSERT INTO offer_observations (
    run_id, ${Object.values(offerColumns).join(", ")}, observed_at, source_url, raw_json
  ) VALUES (
    $runId, ${Object.keys(offerColumns).map((field) => `$${field}`).join(", ")}, $observedAt, $sourceUrl, $rawJson
  ) ON CONFLICT(run_id, snapshot_key) DO NOTHING
`;

interface OfferRow extends NormalizedOffer {
  readonly id: number;
  readonly runId: string;
  readonly profile: ScrapeProfile;
  readonly observedAt: string;
  readonly sourceUrl: string;
  readonly rawJson: string;
}

function timestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Observation and run timestamps must be valid dates");
  }
  // Canonical UTC timestamps make SQLite text ordering chronological.
  return new Date(milliseconds).toISOString();
}

function nonnegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
}

export class OfferRepository {
  private readonly database: Database;

  constructor(databasePath = "data/offers.sqlite") {
    if (!databasePath.trim()) throw new TypeError("A database path is required");
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new Database(databasePath, { create: true, strict: true });

    try {
      this.database.run("PRAGMA foreign_keys = ON");
      this.database.run("PRAGMA busy_timeout = 5000");
      this.database.run("PRAGMA journal_mode = WAL");
      const version = this.database.query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) {
        throw new Error("Unsupported offers database schema version");
      }
      if (version === 0) this.initializeSchema();
      if (version === 1 || version === 2) this.migrateSchema();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  createRun(input: { profile: ScrapeProfile; query: unknown; startedAt: string }): string {
    const queryJson = JSON.stringify(input.query);
    if (queryJson === undefined) throw new TypeError("The run query must be JSON-serializable");
    const id = crypto.randomUUID();
    this.database.query("INSERT INTO scrape_runs (id, profile, query_json, started_at) VALUES (?, ?, ?, ?)")
      .run(id, input.profile, queryJson, timestamp(input.startedAt));
    return id;
  }

  savePage(runId: string, observations: readonly OfferObservation[]): { inserted: number; duplicates: number } {
    return this.database.transaction(() => {
      this.assertRunningRun(runId);

      let inserted = 0;
      let duplicates = 0;
      for (const observation of observations) {
        if (this.insertObservation(runId, observation) === 1) inserted += 1;
        else duplicates += 1;
      }
      return { inserted, duplicates };
    }).immediate();
  }

  getRejected(): readonly {
    id: number;
    runId: string;
    observedAt: string;
    rawJson: string;
    sourceUrl: string;
  }[] {
    return this.database.query<{
      id: number;
      runId: string;
      observedAt: string;
      rawJson: string;
      sourceUrl: string;
    }, [string]>(`
      SELECT rejected.id, rejected.run_id AS runId, rejected.observed_at AS observedAt,
        rejected.raw_json AS rawJson, COALESCE((
          SELECT source_url FROM offer_observations observation
          WHERE observation.run_id = rejected.run_id AND observation.observed_at = rejected.observed_at
          ORDER BY observation.id LIMIT 1
        ), ?) AS sourceUrl
      FROM rejected_offers rejected WHERE rejected.resolved_at IS NULL ORDER BY rejected.id
    `).all("https://thor.wakacje.pl/api/v1/wak-logic/search/listing");
  }

  recoverRejected(id: number, observation: OfferObservation): boolean {
    nonnegativeInteger(id, "rejection id");
    if (id === 0) throw new TypeError("rejection id must be positive");
    return this.database.transaction(() => {
      const rejected = this.database.query<{
        runId: string;
        observedAt: string;
        rawJson: string;
      }, [number]>(`
        SELECT run_id AS runId, observed_at AS observedAt, raw_json AS rawJson
        FROM rejected_offers WHERE id = ? AND resolved_at IS NULL
      `).get(id);
      if (!rejected) return false;
      if (observation.rawJson !== rejected.rawJson
        || timestamp(observation.observedAt) !== timestamp(rejected.observedAt)) {
        throw new TypeError("Recovery must preserve the rejected source JSON and observation time");
      }

      // This explicit repair path appends to the original run without rewriting ingestion summaries.
      this.insertObservation(rejected.runId, observation);
      this.database.query("UPDATE rejected_offers SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
        .run(new Date().toISOString(), id);
      return true;
    }).immediate();
  }

  saveRejected(runId: string, rejected: readonly {
    page: number;
    itemIndex: number;
    observedAt: string;
    rawJson: string;
    reason: string;
  }[]): number {
    return this.database.transaction(() => {
      this.assertRunningRun(runId);
      const insert = this.database.query(`
        INSERT INTO rejected_offers (run_id, page, item_index, observed_at, raw_json, reason)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, page, item_index) DO NOTHING
      `);
      let inserted = 0;
      for (const item of rejected) {
        nonnegativeInteger(item.page, "page");
        nonnegativeInteger(item.itemIndex, "itemIndex");
        if (item.page === 0) throw new TypeError("page must be positive");
        inserted += insert.run(
          runId, item.page, item.itemIndex, timestamp(item.observedAt), item.rawJson, item.reason,
        ).changes;
      }
      return inserted;
    }).immediate();
  }

  finishRun(runId: string, summary: RunSummary): void {
    if (!["completed", "limited", "failed"].includes(summary.status)) {
      throw new TypeError("A finished run must be completed, limited, or failed");
    }
    for (const field of ["pages", "received", "inserted", "rejected"] as const) {
      nonnegativeInteger(summary[field], field);
    }
    if (summary.reportedTotal !== undefined && summary.reportedTotal !== null) {
      nonnegativeInteger(summary.reportedTotal, "reportedTotal");
    }
    if (summary.stopReason !== undefined && !summary.stopReason.trim()) {
      throw new TypeError("stopReason must be nonempty when provided");
    }
    const result = this.database.query(`
      UPDATE scrape_runs SET status = ?, pages = ?, received = ?, inserted = ?, rejected = ?,
        finished_at = ?, error_kind = ?, reported_total = ?, stop_reason = ?
      WHERE id = ? AND status = 'running'
    `).run(
      summary.status, summary.pages, summary.received, summary.inserted, summary.rejected,
      timestamp(summary.finishedAt), summary.errorKind ?? null,
      summary.reportedTotal ?? null, summary.stopReason ?? null, runId,
    );
    if (result.changes !== 1) {
      throw new Error("Cannot finish an unknown or already finished scrape run");
    }
  }

  getStats(): RepositoryStats {
    const result = this.database.query<RepositoryStats, []>(`
      SELECT (SELECT COUNT(*) FROM scrape_runs) AS runs,
        COUNT(*) AS observations, COUNT(DISTINCT comparison_key) AS comparisonGroups,
        (SELECT COUNT(*) FROM rejected_offers WHERE resolved_at IS NULL) AS rejected
      FROM offer_observations
    `).get();
    if (!result) throw new Error("Unable to read offer database statistics");
    return result;
  }

  getObservedDestinations(): readonly { id: number; label: string; iso2Code: string | null }[] {
    const rows = this.database.query<{
      id: unknown; idType: unknown; label: unknown; labelType: unknown; iso2Code: unknown;
    }, []>(`
      SELECT json_extract(raw_json, '$.localisation.country.id') AS id,
        json_type(raw_json, '$.localisation.country.id') AS idType,
        json_extract(raw_json, '$.localisation.country.name') AS label,
        json_type(raw_json, '$.localisation.country.name') AS labelType,
        json_extract(raw_json, '$.localisation.country.iso2Code') AS iso2Code
      FROM offer_observations
      UNION
      SELECT json_extract(raw_json, '$.localisation.country.id') AS id,
        json_type(raw_json, '$.localisation.country.id') AS idType,
        json_extract(raw_json, '$.localisation.country.name') AS label,
        json_type(raw_json, '$.localisation.country.name') AS labelType,
        json_extract(raw_json, '$.localisation.country.iso2Code') AS iso2Code
      FROM rejected_offers
    `).all();
    const destinations = new Map<number, { id: number; label: string; iso2Code: string | null }>();
    for (const row of rows) {
      if ((row.idType !== "integer" && row.idType !== "real")
        || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0
        || row.labelType !== "text" || typeof row.label !== "string" || !row.label.trim()) continue;
      const candidate = {
        id: row.id,
        label: row.label.trim(),
        iso2Code: typeof row.iso2Code === "string" && /^[A-Z]{2}$/.test(row.iso2Code) ? row.iso2Code : null,
      };
      const previous = destinations.get(candidate.id);
      if (!previous
        || (previous.iso2Code === null && candidate.iso2Code !== null)
        || ((previous.iso2Code === null) === (candidate.iso2Code === null)
          && (candidate.label < previous.label
            || (candidate.label === previous.label && (candidate.iso2Code ?? "") < (previous.iso2Code ?? ""))))) {
        destinations.set(candidate.id, candidate);
      }
    }
    return [...destinations.values()].sort((left, right) => left.id - right.id);
  }

  getObservedProviders(): readonly { id: number; label: string }[] {
    const rows = this.database.query<{
      id: unknown; idType: unknown; label: unknown; labelType: unknown;
    }, []>(`
      SELECT json_extract(raw_json, '$.provider.id') AS id,
        json_type(raw_json, '$.provider.id') AS idType,
        json_extract(raw_json, '$.provider.label') AS label,
        json_type(raw_json, '$.provider.label') AS labelType
      FROM offer_observations
      UNION
      SELECT json_extract(raw_json, '$.provider.id') AS id,
        json_type(raw_json, '$.provider.id') AS idType,
        json_extract(raw_json, '$.provider.label') AS label,
        json_type(raw_json, '$.provider.label') AS labelType
      FROM rejected_offers
    `).all();
    const providers = new Map<number, { id: number; label: string }>();
    for (const row of rows) {
      if ((row.idType !== "integer" && row.idType !== "real")
        || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0
        || row.labelType !== "text" || typeof row.label !== "string" || !row.label.trim()) continue;
      const candidate = { id: row.id, label: row.label.trim() };
      const previous = providers.get(candidate.id);
      if (!previous || candidate.label < previous.label) providers.set(candidate.id, candidate);
    }
    return [...providers.values()].sort((left, right) => left.id - right.id);
  }

  getCollectionCheckpoints(since: string): readonly {
    profile: ScrapeProfile;
    countryId: number;
    transportType: number;
    providerId?: number;
    empty: boolean;
  }[] {
    // Resume only explicitly sorted scopes from this batch; unordered legacy pages are ineligible.
    const rows = this.database.query<{
      profile: ScrapeProfile;
      countryId: number;
      transportType: number;
      providerId: number | null;
      empty: 0 | 1;
    }, [string]>(`
      WITH candidates AS (
        SELECT id, profile, started_at, status, received, reported_total,
          json_extract(query_json, '$.destinationCountry[0]') AS countryId,
          json_extract(query_json, '$.transportType[0]') AS transportType,
          json_extract(query_json, '$.providerList[0]') AS providerId
        FROM scrape_runs
        WHERE started_at >= ? AND status IN ('completed', 'limited')
          AND stop_reason IN ('empty-page', 'end-cursor', 'api-window', 'count-mismatch')
          AND (stop_reason <> 'api-window' OR json_type(query_json, '$.providerList') IS NOT NULL)
          AND json_type(query_json, '$.order') = 'integer' AND json_extract(query_json, '$.order') = 1
          AND json_type(query_json, '$.adultCount') = 'integer' AND json_extract(query_json, '$.adultCount') = 2
          AND json_type(query_json, '$.childCount') = 'integer' AND json_extract(query_json, '$.childCount') = 0
          AND json_type(query_json, '$.offerType') IS NULL
          AND json_type(query_json, '$.promotionList') = 'array'
          AND ((profile = 'last-minute' AND json_array_length(query_json, '$.promotionList') = 1
              AND json_type(query_json, '$.promotionList[0]') = 'integer'
              AND json_extract(query_json, '$.promotionList[0]') = 1)
            OR (profile IN ('all', 'all-inclusive') AND json_array_length(query_json, '$.promotionList') = 0))
          AND ((profile IN ('all', 'last-minute') AND json_type(query_json, '$.cateringList') IS NULL)
            OR (profile = 'all-inclusive' AND json_type(query_json, '$.cateringList') = 'array'
              AND json_array_length(query_json, '$.cateringList') = 1
              AND json_type(query_json, '$.cateringList[0]') = 'integer'
              AND json_extract(query_json, '$.cateringList[0]') = 1))
          AND json_type(query_json, '$.destinationCountry') = 'array'
          AND json_array_length(query_json, '$.destinationCountry') = 1
          AND json_type(query_json, '$.destinationCountry[0]') = 'integer'
          AND countryId BETWEEN 1 AND 9007199254740991
          AND json_type(query_json, '$.transportType') = 'array'
          AND json_array_length(query_json, '$.transportType') = 1
          AND json_type(query_json, '$.transportType[0]') = 'integer'
          AND transportType IN (1, 3, 4)
          AND (json_type(query_json, '$.providerList') IS NULL
            OR (json_type(query_json, '$.providerList') = 'array'
              AND json_array_length(query_json, '$.providerList') = 1
              AND json_type(query_json, '$.providerList[0]') = 'integer'
              AND providerId BETWEEN 1 AND 9007199254740991))
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY profile, countryId, transportType, providerId ORDER BY started_at DESC, id DESC
        ) AS checkpoint_rank FROM candidates
      )
      SELECT profile, countryId, transportType, providerId,
        CASE WHEN status = 'completed' AND received = 0 AND reported_total = 0 THEN 1 ELSE 0 END AS empty
      FROM ranked WHERE checkpoint_rank = 1 ORDER BY profile, countryId, transportType, providerId
    `).all(timestamp(since));
    return rows.map(({ providerId, empty, ...row }) => ({
      ...row,
      ...(providerId === null ? {} : { providerId }),
      empty: empty === 1,
    }));
  }

  getLatest(profile?: ScrapeProfile): StoredOffer[] {
    const offerFields = Object.entries(offerColumns)
      .map(([field, column]) => `${column} AS ${field}`).join(", ");
    const rows = this.database.query<OfferRow, [ScrapeProfile | null]>(`
      WITH ranked AS (
        SELECT o.*, r.profile, ROW_NUMBER() OVER (
          PARTITION BY o.comparison_key ORDER BY o.observed_at DESC, o.id DESC
        ) AS observation_rank
        FROM offer_observations o JOIN scrape_runs r ON r.id = o.run_id
        WHERE (?1 IS NULL OR r.profile = ?1)
      )
      SELECT id, run_id AS runId, profile, observed_at AS observedAt, source_url AS sourceUrl,
        raw_json AS rawJson, ${offerFields}
      FROM ranked WHERE observation_rank = 1 ORDER BY price_minor ASC, comparison_key ASC, id ASC
    `).all(profile ?? null);
    return rows.map(({ id, runId, profile: sourceProfile, observedAt, sourceUrl, rawJson, ...offer }) => ({
      id, runId, profile: sourceProfile, observedAt, sourceUrl, rawJson, offer,
    }));
  }

  close(): void {
    this.database.close();
  }

  private assertRunningRun(runId: string): void {
    const run = this.database.query<{ status: RunStatus }, [string]>(
      "SELECT status FROM scrape_runs WHERE id = ?",
    ).get(runId);
    if (!run || run.status !== "running") {
      throw new Error("Offers can only be saved to an existing running scrape run");
    }
  }

  private insertObservation(runId: string, observation: OfferObservation): number {
    const offer = observation.offer;
    for (const field of [
      "sourceId", "hotelId", "departureId", "nights", "cateringId", "priceMinor", "adults", "children",
    ] as const) {
      nonnegativeInteger(offer[field], field);
    }
    for (const field of ["stars", "rating"] as const) {
      const value = offer[field];
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new TypeError(`${field} must be a nonnegative finite number or null`);
      }
    }
    return this.database.query<unknown, [Record<string, string | number | null>]>(insertObservationSql).run({
      ...offer,
      runId,
      observedAt: timestamp(observation.observedAt),
      sourceUrl: observation.sourceUrl,
      rawJson: observation.rawJson,
    }).changes;
  }

  private migrateSchema(): void {
    this.database.transaction(() => {
      // Recheck after acquiring the writer lock: another connection may have migrated first.
      const version = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      if (version === 3) return;
      if (version !== 1 && version !== 2) throw new Error("Unsupported offers database schema version");
      if (version === 1) {
        this.database.run("ALTER TABLE rejected_offers ADD COLUMN resolved_at TEXT");
      }
      this.database.run("ALTER TABLE scrape_runs ADD COLUMN reported_total INTEGER CHECK(reported_total >= 0)");
      this.database.run("ALTER TABLE scrape_runs ADD COLUMN stop_reason TEXT CHECK(stop_reason IS NULL OR length(stop_reason) > 0)");
      this.database.run("PRAGMA user_version = 3");
    }).immediate();
  }

  private initializeSchema(): void {
    this.database.transaction(() => {
      this.database.run(`CREATE TABLE scrape_runs (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL CHECK(profile IN ('all', 'last-minute', 'all-inclusive')),
        query_json TEXT NOT NULL CHECK(json_valid(query_json)),
        started_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'limited', 'failed')),
        pages INTEGER NOT NULL DEFAULT 0 CHECK(pages >= 0),
        received INTEGER NOT NULL DEFAULT 0 CHECK(received >= 0),
        inserted INTEGER NOT NULL DEFAULT 0 CHECK(inserted >= 0),
        rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected >= 0),
        finished_at TEXT,
        error_kind TEXT,
        reported_total INTEGER CHECK(reported_total >= 0),
        stop_reason TEXT CHECK(stop_reason IS NULL OR length(stop_reason) > 0)
      ) STRICT`);
      this.database.run(`CREATE TABLE offer_observations (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES scrape_runs(id),
        snapshot_key TEXT NOT NULL,
        comparison_key TEXT NOT NULL,
        source_id INTEGER NOT NULL CHECK(source_id >= 0),
        hotel_id INTEGER NOT NULL CHECK(hotel_id >= 0),
        name TEXT NOT NULL,
        country TEXT NOT NULL,
        country_code TEXT NOT NULL,
        region TEXT NOT NULL,
        departure_id INTEGER NOT NULL CHECK(departure_id >= 0),
        departure TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        nights INTEGER NOT NULL CHECK(nights >= 0),
        catering_id INTEGER NOT NULL CHECK(catering_id >= 0),
        catering TEXT NOT NULL,
        provider_code TEXT NOT NULL,
        provider TEXT NOT NULL,
        room_id TEXT,
        stars REAL CHECK(stars >= 0),
        rating REAL CHECK(rating >= 0),
        price_minor INTEGER NOT NULL CHECK(price_minor >= 0),
        currency TEXT NOT NULL,
        price_type TEXT NOT NULL CHECK(price_type = 'total'),
        adults INTEGER NOT NULL CHECK(adults >= 0),
        children INTEGER NOT NULL CHECK(children >= 0),
        source_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        source_url TEXT NOT NULL,
        raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
        UNIQUE(run_id, snapshot_key)
      ) STRICT`);
      this.database.run("CREATE INDEX observations_comparison_time ON offer_observations(comparison_key, observed_at DESC, id DESC)");
      this.database.run("CREATE INDEX runs_profile ON scrape_runs(profile)");
      this.database.run(`CREATE TABLE rejected_offers (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES scrape_runs(id),
        page INTEGER NOT NULL CHECK(page > 0),
        item_index INTEGER NOT NULL CHECK(item_index >= 0),
        observed_at TEXT NOT NULL,
        raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
        reason TEXT NOT NULL CHECK(length(reason) > 0),
        resolved_at TEXT,
        UNIQUE(run_id, page, item_index)
      ) STRICT`);
      this.database.run("PRAGMA user_version = 3");
    }).immediate();
  }
}

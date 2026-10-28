import { setTimeout as delay } from "node:timers/promises";
import { HttpError } from "../http/HttpError";
import type { WakacjeClient, OfferListingOptions } from "../services/WakacjeClient";
import type { OfferRepository } from "../storage/OfferRepository";
import { normalizeOffer } from "./normalizeOffer";
import type { OfferObservation, ScrapeProfile } from "./types";

export interface CollectionProgress {
  readonly runId: string;
  readonly profile: ScrapeProfile;
  readonly pages: number;
  readonly received: number;
  readonly uniqueSourceIds: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly reportedTotal: number | null;
}

export interface CollectionResult extends CollectionProgress {
  readonly status: "completed" | "limited";
  readonly stopReason: "end-cursor" | "empty-page" | "max-pages" | "api-window" | "count-mismatch";
}

export interface CollectionOptions {
  readonly profile: ScrapeProfile;
  readonly pageSize?: number;
  readonly delayMs?: number;
  readonly maxPages?: number;
  readonly destinationCountry?: readonly number[];
  readonly transportType?: readonly number[];
  readonly offerType?: readonly number[];
  readonly providerList?: readonly number[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CollectionProgress) => void;
}

export class OfferCollector {
  constructor(
    private readonly client: Pick<WakacjeClient, "listOffers">,
    private readonly repository: OfferRepository,
  ) {}

  async collect({
    profile,
    pageSize = 100,
    delayMs = 1_000,
    maxPages,
    destinationCountry,
    transportType,
    offerType,
    providerList,
    signal,
    onProgress,
  }: CollectionOptions): Promise<CollectionResult> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RangeError("pageSize must be an integer between 1 and 100");
    }
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
      throw new RangeError("delayMs must be a nonnegative timer-safe integer");
    }
    if (maxPages !== undefined && (!Number.isSafeInteger(maxPages) || maxPages < 1)) {
      throw new RangeError("maxPages must be a positive integer when supplied");
    }
    if (profile !== "all" && profile !== "last-minute" && profile !== "all-inclusive") {
      throw new TypeError("Unknown scrape profile");
    }

    const query: OfferListingOptions = {
      adultCount: 2, childCount: 0, limit: pageSize, imageLimit: 0,
      order: 1,
      promotionList: profile === "last-minute" ? [1] : [],
      ...(profile === "all-inclusive" ? { cateringList: [1] } : {}),
      ...(destinationCountry === undefined ? {} : { destinationCountry }),
      ...(transportType === undefined ? {} : { transportType }),
      ...(offerType === undefined ? {} : { offerType }),
      ...(providerList === undefined ? {} : { providerList }),
    };
    const runId = this.repository.createRun({ profile, query, startedAt: new Date().toISOString() });
    const progress = { runId, profile, pages: 0, received: 0, uniqueSourceIds: 0, inserted: 0, duplicates: 0, rejected: 0, reportedTotal: null as number | null };
    const seenCursors = new Set<string>();
    const seenPages = new Set<string>();
    const seenSourceIds = new Set<number>();
    let cursor: string | undefined;

    try {
      while (true) {
        signal?.throwIfAborted();
        const response = await this.fetchPage({ ...query, ...(cursor === undefined ? {} : { cursor }) }, signal);
        const listing = response.data;
        if (!listing) throw new TypeError("Missing listing response");
        const observedAt = new Date().toISOString();
        const valid: OfferObservation[] = [];
        const rejected: Parameters<OfferRepository["saveRejected"]>[1][number][] = [];
        for (const [itemIndex, raw] of listing.data.entries()) {
          const rawJson = JSON.stringify(raw);
          try {
            const offer = normalizeOffer(raw, { adultCount: 2, childCount: 0 });
            valid.push({ offer, observedAt, sourceUrl: response.url, rawJson });
          } catch (error: unknown) {
            if (!(error instanceof TypeError)) throw error;
            rejected.push({ page: progress.pages + 1, itemIndex, observedAt, rawJson, reason: error.message });
          }
        }

        const saved = this.repository.savePage(runId, valid);
        progress.pages++;
        progress.received += listing.data.length;
        progress.inserted += saved.inserted;
        progress.duplicates += saved.duplicates;
        for (const observation of valid) seenSourceIds.add(observation.offer.sourceId);
        progress.uniqueSourceIds = seenSourceIds.size;
        this.repository.saveRejected(runId, rejected);
        progress.rejected += rejected.length;
        if (listing.meta?.total !== undefined && (listing.meta.total > 0 || progress.reportedTotal === null)) {
          progress.reportedTotal = listing.meta.total;
        }
        onProgress?.({ ...progress });

        if (listing.data.length > 0) {
          // API hashes can rotate while visible listing identities stay unchanged.
          const identities = valid.length > 0
            ? valid.map((observation) => observation.offer.comparisonKey).sort()
            : listing.data;
          const pageKey = Bun.hash(JSON.stringify(identities)).toString();
          if (seenPages.has(pageKey)) throw new Error("API repeated a nonempty page");
          seenPages.add(pageKey);
          if (!listing.meta || !("cursor" in listing.meta)) throw new TypeError("Missing API pagination cursor");
        }

        let stopReason: CollectionResult["stopReason"] | undefined;
        const next = listing.meta?.cursor;
        if (listing.data.length === 0 && (!next || listing.meta?.total === 0)) stopReason = "empty-page";
        if (!stopReason && !next) stopReason = "end-cursor";
        if (!stopReason && maxPages !== undefined && progress.pages >= maxPages) stopReason = "max-pages";
        if (stopReason) {
          // A terminal cursor is not evidence of full coverage when the API advertises more results.
          if (stopReason !== "max-pages" && progress.reportedTotal !== null
            && progress.uniqueSourceIds < progress.reportedTotal) {
            stopReason = progress.pages > 100 && progress.reportedTotal > 10_000
              ? "api-window"
              : "count-mismatch";
          }
          const status = stopReason === "end-cursor" || stopReason === "empty-page" ? "completed" : "limited";
          this.repository.finishRun(runId, { ...progress, status, stopReason, finishedAt: new Date().toISOString() });
          return { ...progress, status, stopReason };
        }
        if (!next || seenCursors.has(next)) throw new Error("API repeated a pagination cursor");
        seenCursors.add(next);
        cursor = next;
        if (delayMs > 0) await delay(delayMs, undefined, signal ? { signal } : undefined);
      }
    } catch (error: unknown) {
      this.repository.finishRun(runId, {
        ...progress, status: "failed", finishedAt: new Date().toISOString(),
        errorKind: error instanceof HttpError ? `HTTP_${error.status}` : error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  private async fetchPage(query: OfferListingOptions, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return signal ? await this.client.listOffers(query, signal) : await this.client.listOffers(query);
      } catch (error: unknown) {
        // A bounded retry is specific to this read-only pagination workflow.
        const retryableHttp = error instanceof HttpError && [429, 500, 502, 503, 504].includes(error.status);
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        if ((!retryableHttp && !timedOut) || attempt >= 3) throw error;
        const retryAfter = error instanceof HttpError ? error.headers.get("Retry-After") : null;
        const seconds = retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : null;
        const dateWait = retryAfter === null ? Number.NaN : Date.parse(retryAfter) - Date.now();
        const waitMs = seconds !== null
          ? seconds * 1_000
          : Number.isFinite(dateWait) ? Math.max(0, dateWait) : 2_000 * 2 ** attempt;
        if (!Number.isFinite(waitMs) || waitMs > 2_147_483_647) throw error;
        await delay(Math.max(1_000, waitMs), undefined, signal ? { signal } : undefined);
      }
    }
  }
}

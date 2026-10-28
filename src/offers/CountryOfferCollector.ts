import { setTimeout as delay } from "node:timers/promises";
import { HttpError } from "../http/HttpError";
import type { DestinationCountry, TravelProvider, WakacjeClient } from "../services/WakacjeClient";
import type { OfferRepository } from "../storage/OfferRepository";
import { OfferCollector } from "./OfferCollector";
import type { CollectionProgress, CollectionResult } from "./OfferCollector";
import type { ScrapeProfile } from "./types";

interface CountryScope {
  readonly countryId: number;
  readonly country: string;
  readonly transportType: number;
  readonly providerId?: number;
}

export interface CountryCollectionProgress extends CollectionProgress, CountryScope {}
export interface CountryCollectionResult extends CollectionResult, CountryScope {}

export interface CountryCollectionFailure extends CountryScope {
  readonly profile: ScrapeProfile;
  readonly errorKind: string;
  readonly status?: number;
}

export interface CountryCollectionOptions {
  readonly profiles: readonly ScrapeProfile[];
  readonly pageSize?: number;
  readonly delayMs?: number;
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
  /** Explicitly resume scopes with terminal checkpoints at or after this instant. */
  readonly resumeSince?: string;
  readonly onProgress?: (progress: CountryCollectionProgress) => void;
  readonly onResult?: (result: CountryCollectionResult) => void;
  readonly onFailure?: (failure: CountryCollectionFailure) => void;
}

export interface CountryCollectionSummary {
  readonly results: readonly CountryCollectionResult[];
  readonly skipped: number;
  readonly failures: readonly CountryCollectionFailure[];
}

const transportTypes = [1, 3, 4] as const;

function scopeKey(profile: ScrapeProfile, countryId: number, transportType: number, providerId?: number): string {
  return `${profile}:${countryId}:${transportType}:${providerId ?? "all"}`;
}

function emptyScopeKey(countryId: number, transportType: number, providerId?: number): string {
  return `${countryId}:${transportType}:${providerId ?? "all"}`;
}

function isRecoverableScopeError(error: unknown): error is HttpError | DOMException {
  return (error instanceof HttpError && [429, 500, 502, 503, 504].includes(error.status))
    || (error instanceof DOMException && error.name === "TimeoutError");
}

function validateOptions(options: CountryCollectionOptions): void {
  if (options.profiles.length === 0 || options.profiles.some(
    (profile) => profile !== "all" && profile !== "last-minute" && profile !== "all-inclusive",
  )) {
    throw new TypeError("At least one valid collection profile is required");
  }
  const { pageSize = 100, delayMs = 1_000, maxPages, resumeSince } = options;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("pageSize must be an integer between 1 and 100");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
    throw new RangeError("delayMs must be a nonnegative timer-safe integer");
  }
  if (maxPages !== undefined && (!Number.isSafeInteger(maxPages) || maxPages < 1)) {
    throw new RangeError("maxPages must be a positive safe integer");
  }
  if (resumeSince !== undefined && !Number.isFinite(Date.parse(resumeSince))) {
    throw new TypeError("resumeSince must be a valid timestamp");
  }
}

export class CountryOfferCollector {
  private readonly collector: Pick<OfferCollector, "collect">;

  constructor(
    private readonly client: Pick<WakacjeClient, "getDestinations" | "getProviders" | "listOffers">,
    private readonly repository: OfferRepository,
    collector?: Pick<OfferCollector, "collect">,
  ) {
    this.collector = collector ?? new OfferCollector(client, repository);
  }

  async collect(options: CountryCollectionOptions): Promise<CountryCollectionSummary> {
    validateOptions(options);
    const { pageSize = 100, delayMs = 1_000, maxPages, signal, resumeSince, onProgress, onResult, onFailure } = options;
    signal?.throwIfAborted();

    const checkpoints = resumeSince === undefined
      ? []
      : this.repository.getCollectionCheckpoints(new Date(resumeSince).toISOString());
    const completedScopes = new Set<string>();
    const emptyScopes = new Set<string>();
    const partitionedScopes = new Set<string>();
    for (const checkpoint of checkpoints) {
      completedScopes.add(scopeKey(checkpoint.profile, checkpoint.countryId, checkpoint.transportType, checkpoint.providerId));
      if (checkpoint.providerId !== undefined) {
        partitionedScopes.add(scopeKey(checkpoint.profile, checkpoint.countryId, checkpoint.transportType));
      }
      if (checkpoint.profile === "all" && checkpoint.empty) {
        emptyScopes.add(emptyScopeKey(checkpoint.countryId, checkpoint.transportType, checkpoint.providerId));
      }
    }

    const catalog = await this.client.getDestinations(signal);
    if (catalog.data === undefined) throw new TypeError("Missing destination catalog response");
    const countries = new Map<number, DestinationCountry>();
    for (const country of [...this.repository.getObservedDestinations(), ...catalog.data]) {
      countries.set(country.id, country);
    }
    if (countries.size === 0) throw new TypeError("The API returned no destination countries");

    // Run the unrestricted profile first so its proven empty scopes can skip subsets.
    const uniqueProfiles = [...new Set(options.profiles)];
    const profiles: readonly ScrapeProfile[] = uniqueProfiles.includes("all")
      ? ["all", ...uniqueProfiles.filter((profile) => profile !== "all")]
      : uniqueProfiles;
    const results: CountryCollectionResult[] = [];
    const failures: CountryCollectionFailure[] = [];
    let skipped = 0;
    let hasRequested = false;
    let providerCatalog: Promise<readonly TravelProvider[]> | undefined;

    const pace = async () => {
      signal?.throwIfAborted();
      if (hasRequested && delayMs > 0) {
        await delay(delayMs, undefined, signal ? { signal } : undefined);
      }
      signal?.throwIfAborted();
      hasRequested = true;
    };
    const providers = async (): Promise<readonly TravelProvider[]> => {
      providerCatalog ??= (async () => {
        await pace();
        const response = await this.client.getProviders(signal);
        if (response.data === undefined) throw new TypeError("Missing provider catalog response");
        return response.data;
      })();
      const catalog = await providerCatalog;
      const available = new Map<number, TravelProvider>();
      for (const provider of [...this.repository.getObservedProviders(), ...catalog]) {
        available.set(provider.id, provider);
      }
      return [...available.values()];
    };
    const shouldSkip = (profile: ScrapeProfile, scope: CountryScope) => {
      return completedScopes.has(scopeKey(profile, scope.countryId, scope.transportType, scope.providerId))
        || (profile !== "all" && emptyScopes.has(emptyScopeKey(scope.countryId, scope.transportType, scope.providerId)));
    };
    const recordFailure = (
      profile: ScrapeProfile,
      scope: CountryScope,
      error: HttpError | DOMException | "ProviderCatalogEmpty",
    ) => {
      const failure: CountryCollectionFailure = {
        ...scope,
        profile,
        errorKind: typeof error === "string" ? error : error instanceof HttpError ? `HTTP_${error.status}` : "TimeoutError",
        ...(error instanceof HttpError ? { status: error.status } : {}),
      };
      failures.push(failure);
      onFailure?.(failure);
    };
    const attempt = async (profile: ScrapeProfile, scope: CountryScope): Promise<
      { result: CountryCollectionResult } | { error: HttpError | DOMException }
    > => {
      await pace();
      let result: CollectionResult;
      try {
        result = await this.collector.collect({
          profile,
          destinationCountry: [scope.countryId],
          transportType: [scope.transportType],
          ...(scope.providerId === undefined ? {} : { providerList: [scope.providerId] }),
          pageSize,
          delayMs,
          ...(maxPages === undefined ? {} : { maxPages }),
          ...(signal === undefined ? {} : { signal }),
          ...(onProgress === undefined ? {} : { onProgress: (progress) => onProgress({ ...progress, ...scope }) }),
        });
      } catch (error: unknown) {
        signal?.throwIfAborted();
        if (!isRecoverableScopeError(error)) throw error;
        return { error };
      }
      const scopedResult = { ...result, ...scope };
      results.push(scopedResult);
      if (profile === "all" && result.status === "completed" && result.pages > 0
        && result.received === 0 && result.reportedTotal === 0) {
        emptyScopes.add(emptyScopeKey(scope.countryId, scope.transportType, scope.providerId));
      }
      onResult?.(scopedResult);
      return { result: scopedResult };
    };
    const collectProviders = async (
      profile: ScrapeProfile,
      scope: CountryScope,
      cause?: HttpError | DOMException,
    ) => {
      let available: readonly TravelProvider[];
      try {
        available = await providers();
      } catch (error: unknown) {
        signal?.throwIfAborted();
        if (!isRecoverableScopeError(error)) throw error;
        recordFailure(profile, scope, error);
        return;
      }
      if (available.length === 0) {
        recordFailure(profile, scope, cause ?? "ProviderCatalogEmpty");
        return;
      }
      for (const provider of available) {
        signal?.throwIfAborted();
        const child: CountryScope = { ...scope, providerId: provider.id };
        if (shouldSkip(profile, child)) {
          skipped++;
          continue;
        }
        const outcome = await attempt(profile, child);
        if ("error" in outcome) recordFailure(profile, child, outcome.error);
      }
    };

    for (const country of countries.values()) {
      for (const profile of profiles) {
        for (const transportType of transportTypes) {
          signal?.throwIfAborted();
          const scope: CountryScope = { countryId: country.id, country: country.label, transportType };
          if (shouldSkip(profile, scope)) {
            skipped++;
            continue;
          }
          if (partitionedScopes.has(scopeKey(profile, country.id, transportType))) {
            let available: readonly TravelProvider[] = [];
            try {
              available = await providers();
            } catch (error: unknown) {
              signal?.throwIfAborted();
              if (!isRecoverableScopeError(error)) throw error;
              // A catalog outage is not evidence that the base listing also fails.
            }
            if (available.length > 0 && available.every((provider) => completedScopes.has(
              scopeKey(profile, country.id, transportType, provider.id),
            ))) {
              await collectProviders(profile, scope);
              continue;
            }
          }
          const outcome = await attempt(profile, scope);
          if ("error" in outcome) await collectProviders(profile, scope, outcome.error);
          else if (outcome.result.stopReason === "api-window") await collectProviders(profile, scope);
        }
      }
    }
    return { results, skipped, failures };
  }
}

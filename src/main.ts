import { CookieJar } from "tough-cookie";
import { FirebaseInstallationsSession } from "./session/FirebaseInstallationsSession";
import { WakacjeClient } from "./services/WakacjeClient";
import { resolve } from "node:path";
import { OfferCollector } from "./offers/OfferCollector";
import type { CollectionProgress } from "./offers/OfferCollector";
import { CountryOfferCollector } from "./offers/CountryOfferCollector";
import { OfferRepository } from "./storage/OfferRepository";
import { getOfferTransport, rankOffers } from "./offers/rankOffers";
import type { ScrapeProfile, StoredOffer } from "./offers/types";

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

function requiredEnvironment(name: string): string {
  const value = Bun.env[name];
  if (!value?.trim()) {
    throw new ConfigurationError(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const flags = new Set(["--firebase", "--offers", "--collect", "--deals", "--stats", "--by-country"]);
  const values = new Map<string, string>();
  for (const arg of args) {
    if (flags.has(arg)) continue;
    const separator = arg.indexOf("=");
    const name = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (separator < 1 || !["--db", "--profile", "--page-size", "--max-pages", "--delay-ms", "--limit", "--resume-since", "--offer-type"].includes(name) || !value) {
      throw new ConfigurationError("Use --collect, --deals, --stats, --firebase; options use --name=value.");
    }
    values.set(name, value);
  }
  if (args.length === 0) {
    console.info("Use bun run scrape to collect offer listings, bun run deals to read saved offers, or bun run stats.");
    return;
  }

  const integer = (name: string, fallback: number): number => {
    const value = values.has(name) ? Number(values.get(name)) : fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new ConfigurationError(`${name} must be a positive integer`);
    return value;
  };

  if (args.includes("--firebase")) {
    const firebase = new FirebaseInstallationsSession({
      projectId: requiredEnvironment("FIREBASE_PROJECT_ID"),
      appId: requiredEnvironment("FIREBASE_APP_ID"),
      apiKey: requiredEnvironment("FIREBASE_API_KEY"),
      sdkVersion: requiredEnvironment("FIREBASE_SDK_VERSION"),
    });
    await firebase.getAuthToken();
    console.info("Firebase installation initialized; token cached in memory for this session.");
  }

  const collecting = args.includes("--offers") || args.includes("--collect");
  if (collecting || args.includes("--deals") || args.includes("--stats")) {
    const repository = new OfferRepository(resolve(values.get("--db") ?? "data/offers.sqlite"));
    try {
      if (collecting) {
        const selected = values.get("--profile");
        const profiles: readonly ScrapeProfile[] = selected === undefined || selected === "both"
          ? ["all", "last-minute", "all-inclusive"]
          : selected === "all" || selected === "last-minute" || selected === "all-inclusive"
            ? [selected]
            : (() => { throw new ConfigurationError("Unknown --profile value"); })();
        const client = new WakacjeClient({
          authorization: requiredEnvironment("WAKACJE_AUTHORIZATION"),
          deviceId: Bun.env["WAKACJE_DEVICE_ID"] || crypto.randomUUID(),
          cookieJar: new CookieJar(),
        });
        const collector = new OfferCollector(client, repository);
        const controller = new AbortController();
        const interrupt = () => controller.abort(new DOMException("Collection interrupted", "AbortError"));
        process.once("SIGINT", interrupt);
        try {
          const options = {
            pageSize: integer("--page-size", 100),
            delayMs: Math.max(1_000, integer("--delay-ms", 1_000)),
            signal: controller.signal,
            ...(values.has("--max-pages") ? { maxPages: integer("--max-pages", 1) } : {}),
          };
          const reportProgress = (scope: string, progress: CollectionProgress) => {
            if (progress.pages === 1 || progress.pages % 10 === 0) {
              console.info(`${scope}: page ${progress.pages}, unique IDs ${progress.uniqueSourceIds}/${progress.reportedTotal ?? "?"}, received ${progress.received}, saved ${progress.inserted}, rejected ${progress.rejected}, duplicates ${progress.duplicates}`);
            }
          };
          if (args.includes("--by-country")) {
            if (values.has("--offer-type")) throw new ConfigurationError("--offer-type is supported for unpartitioned --collect only");
            console.info(`Collection started at ${new Date().toISOString()}; country × profile × transport, sorted by price.`);
            const summary = await new CountryOfferCollector(client, repository, collector).collect({
              ...options,
              profiles,
              ...(values.has("--resume-since") ? { resumeSince: values.get("--resume-since")! } : {}),
              onProgress: (progress) => reportProgress(`${progress.profile}/${progress.country}/transport ${progress.transportType}${progress.providerId === undefined ? "" : `/provider ${progress.providerId}`}`, progress),
              onResult: (result) => console.info(JSON.stringify(result)),
              onFailure: (failure) => console.warn(JSON.stringify({ failedScope: failure })),
            });
            const limited = summary.results.filter((result) => result.status === "limited");
            console.info({ collectedScopes: summary.results.length, skippedScopes: summary.skipped, limitedScopes: limited.length, failedScopes: summary.failures.length });
            if (limited.length > 0 || summary.failures.length > 0) {
              console.warn("Some query scopes are partial; inspect their reported totals and stop reasons in scrape_runs.");
            }
            if (summary.failures.length > 0) process.exitCode = 2;
          } else {
            if (values.has("--resume-since")) throw new ConfigurationError("--resume-since requires --by-country");
            for (const profile of profiles) {
              const result = await collector.collect({
                ...options, profile,
                ...(values.has("--offer-type") ? { offerType: [integer("--offer-type", 2)] } : {}),
                onProgress: (progress) => reportProgress(profile, progress),
              });
              console.info(JSON.stringify(result));
              if (result.status === "limited") {
                console.warn("This query is partial. Use bun run scrape to partition by country and transport.");
              }
            }
          }
        } finally {
          process.removeListener("SIGINT", interrupt);
        }
      }

      console.info({ database: resolve(values.get("--db") ?? "data/offers.sqlite"), ...repository.getStats() });
      if (collecting || args.includes("--deals")) {
        const latest = repository.getLatest();
        const displayLimit = integer("--limit", 10);
        const show = (label: string, candidates: readonly StoredOffer[], qualityOnly = false) => {
          console.info(label);
          console.table(rankOffers(candidates, { limit: displayLimit, qualityOnly }).map(({ observation, belowMedianPercent, peerHotels }) => ({
            hotel: observation.offer.name,
            country: observation.offer.country,
            totalPLN: observation.offer.priceMinor / 100,
            rating: observation.offer.rating,
            stars: observation.offer.stars,
            nights: observation.offer.nights,
            from: observation.offer.departure,
            start: observation.offer.startDate,
            board: observation.offer.catering,
            transport: getOfferTransport(observation)?.label ?? "unknown",
            sampleDifferencePercent: belowMedianPercent === null ? null : Math.round(belowMedianPercent),
            peerHotels,
          })));
        };
        const flightsOnly = (offer: StoredOffer) => getOfferTransport(offer)?.id === 1;
        show("Cheapest saved offers (total for two adults; check transport)", latest);
        show("Last Minute with flights (total for two adults)", repository.getLatest("last-minute").filter(flightsOnly));
        show("All Inclusive with flights, rating >=8 and hotel category >=4", latest.filter(
          (observation) => observation.offer.cateringId === 1 && flightsOnly(observation),
        ), true);
      }
    } finally {
      repository.close();
    }
  }
}

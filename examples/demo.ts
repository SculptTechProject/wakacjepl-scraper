import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { normalizeOffer } from "../src/offers/normalizeOffer";
import { rankOffers } from "../src/offers/rankOffers";
import { OfferRepository } from "../src/storage/OfferRepository";

const day = 86_400_000;

export function createDemo(databasePath = "data/demo.sqlite", now = new Date()) {
  const path = resolve(databasePath);
  if (basename(path) !== "demo.sqlite") {
    throw new Error("The offline demo only creates a new file named demo.sqlite.");
  }
  const observedAt = now.toISOString();
  const startDate = new Date(now.getTime() + 14 * day).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + 21 * day).toISOString().slice(0, 10);

  mkdirSync(dirname(path), { recursive: true });
  if (lstatSync(path, { throwIfNoEntry: false })) {
    throw new Error(`Refusing to overwrite ${path}; choose a new directory for the demo.`);
  }
  if (["-wal", "-shm", "-journal"].some((suffix) => lstatSync(`${path}${suffix}`, { throwIfNoEntry: false }))) {
    throw new Error("Refusing to open a demo path with existing SQLite sidecar files.");
  }
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite ${path}; choose a new directory for the demo.`);
    }
    throw error;
  }

  const repository = new OfferRepository(path);
  try {
    for (const revision of [0, 1]) {
      const time = new Date(now.getTime() - (1 - revision) * day).toISOString();
      const runId = repository.createRun({
        profile: "all-inclusive",
        query: { synthetic: true, adultCount: 2, childCount: 0, revision },
        startedAt: time,
      });
      const observations = [2400, 2800, 3000, 3200, 3400, 3600].map((price, index) => {
        const raw = {
          synthetic: true,
          id: index + 1,
          label: `Synthetic Hotel ${index + 1}`,
          hash: `synthetic-${index}-${revision}`,
          object: { id: index + 1, category: 4 },
          localisation: {
            country: { id: 1, name: "Fictional destination", iso2Code: "XX" },
            region: { name: "Demo coast" },
          },
          departure: { id: 1, label: "Demo airport" },
          transport: { id: 1, unifiedName: "Flight (synthetic)", startDate, endDate, nights: 7 },
          catering: { id: 1, label: "All Inclusive" },
          provider: { id: 1, code: "DEMO", label: "Synthetic Travel" },
          roomId: "demo-double",
          rating: { value: 8.5 },
          price: { type: "total", currency: "PLN", value: price + (revision === 0 ? 200 : 0) },
        };
        return {
          offer: normalizeOffer(raw, { adultCount: 2, childCount: 0 }),
          rawJson: JSON.stringify(raw),
          sourceUrl: "https://example.invalid/synthetic-offers",
          observedAt: time,
        };
      });
      const saved = repository.savePage(runId, observations);
      repository.finishRun(runId, {
        status: "completed", pages: 1, received: observations.length, inserted: saved.inserted,
        rejected: 0, reportedTotal: observations.length, stopReason: "synthetic-fixture", finishedAt: time,
      });
    }
    return {
      databasePath: path,
      observedAt,
      stats: repository.getStats(),
      ranked: rankOffers(repository.getLatest(), { asOfDate: observedAt.slice(0, 10) }),
    };
  } finally {
    repository.close();
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && !args[0].startsWith("--db="))) {
    throw new Error("Usage: bun run examples/demo.ts [--db=path/to/demo.sqlite]");
  }
  const demo = createDemo(args[0]?.slice("--db=".length));
  console.info("OFFLINE DEMO — SYNTHETIC DATA. Hotels and prices are fictional.");
  console.info({ database: demo.databasePath, ...demo.stats });
  console.table(demo.ranked.map(({ observation, belowMedianPercent, peerHotels }) => ({
    hotel: observation.offer.name,
    totalPLN: observation.offer.priceMinor / 100,
    start: observation.offer.startDate,
    nights: observation.offer.nights,
    peerHotels,
    belowSampleMedianPercent: belowMedianPercent === null ? null : Math.round(belowMedianPercent),
  })));
}

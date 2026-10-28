import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError, main } from "../src/main";
import { normalizeOffer } from "../src/offers/normalizeOffer";
import { OfferRepository } from "../src/storage/OfferRepository";

const directories: string[] = [];
const serviceEnvironment = [
  "WAKACJE_AUTHORIZATION", "WAKACJE_DEVICE_ID", "FIREBASE_PROJECT_ID",
  "FIREBASE_APP_ID", "FIREBASE_API_KEY", "FIREBASE_SDK_VERSION",
] as const;
const originalEnvironment = new Map(serviceEnvironment.map((name) => [name, Bun.env[name]]));
let unexpectedRequests = 0;

beforeEach(() => {
  unexpectedRequests = 0;
  const implementation = async () => {
    unexpectedRequests++;
    throw new Error("CLI read tests must not make network requests");
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
  for (const name of serviceEnvironment) delete Bun.env[name];
});

afterEach(() => {
  mock.restore();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
  }
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
  expect(unexpectedRequests).toBe(0);
});

function quietConsole() {
  return {
    info: spyOn(console, "info").mockImplementation(() => {}),
    table: spyOn(console, "table").mockImplementation(() => {}),
    warn: spyOn(console, "warn").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function databasePath(filename = "offers.sqlite"): string {
  const directory = mkdtempSync(join(tmpdir(), "wakacje-cli-"));
  directories.push(directory);
  return join(directory, filename);
}

function seedOffer(path: string): void {
  const now = new Date();
  const source = {
    id: 1,
    label: "CLI fixture resort",
    hash: "public-fixture-hash",
    object: { id: 101, category: 4 },
    localisation: {
      country: { id: 16, name: "Example country", iso2Code: "EX" },
      region: { name: "Example region" },
    },
    departure: { id: 1, label: "Example airport" },
    transport: {
      id: 1,
      unifiedName: "samolotem",
      startDate: new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10),
      endDate: new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10),
      nights: 7,
    },
    catering: { id: 1, label: "All Inclusive" },
    provider: { code: "EXAMPLE", label: "Example provider" },
    roomId: "",
    rating: { value: 8.5 },
    price: { type: "total", currency: "PLN", value: 1234.56 },
  };
  const repository = new OfferRepository(path);
  try {
    const runId = repository.createRun({ profile: "all", query: {}, startedAt: now.toISOString() });
    repository.savePage(runId, [{
      offer: normalizeOffer(source, { adultCount: 2, childCount: 0 }),
      observedAt: now.toISOString(),
      sourceUrl: "https://example.test/public/search/listing",
      rawJson: JSON.stringify(source),
    }]);
    repository.finishRun(runId, {
      status: "completed", pages: 1, received: 1, inserted: 1, rejected: 0,
      reportedTotal: 1, stopReason: "end-cursor", finishedAt: now.toISOString(),
    });
  } finally {
    repository.close();
  }
}

describe("CLI dispatch", () => {
  test("prints help without configuration when no arguments are supplied", async () => {
    const output = quietConsole();

    await main([]);

    expect(output.info).toHaveBeenCalledTimes(1);
    expect(output.info.mock.calls[0]?.[0]).toContain("bun run scrape");
    expect(output.table).not.toHaveBeenCalled();
  });

  test("reads saved SQLite statistics without any service configuration", async () => {
    const output = quietConsole();
    const path = databasePath();
    seedOffer(path);

    await main(["--stats", `--db=${path}`]);

    expect(output.info).toHaveBeenCalledWith({
      database: path, runs: 1, observations: 1, comparisonGroups: 1, rejected: 0,
    });
    expect(output.table).not.toHaveBeenCalled();
  });

  test("displays saved offer prices and transport without making API requests", async () => {
    const output = quietConsole();
    const path = databasePath();
    seedOffer(path);

    await main(["--deals", `--db=${path}`, "--limit=1"]);

    expect(output.table).toHaveBeenCalled();
    expect(output.table.mock.calls[0]?.[0]).toMatchObject([{
      hotel: "CLI fixture resort", totalPLN: 1234.56, rating: 8.5,
      board: "All Inclusive", transport: "samolotem", sampleDifferencePercent: null,
    }]);
  });

  test("preserves equals signs within an explicit database path", async () => {
    const output = quietConsole();
    const path = databasePath("offers=local.sqlite");
    seedOffer(path);

    await main(["--stats", `--db=${path}`]);

    expect(output.info.mock.calls[0]?.[0]).toMatchObject({ database: path, observations: 1 });
  });

  test("rejects an unknown flag as a configuration error", async () => {
    const output = quietConsole();

    await expect(main(["--unknown-flag"])).rejects.toBeInstanceOf(ConfigurationError);
    expect(output.info).not.toHaveBeenCalled();
  });

  test("importing index.ts neither runs the CLI nor starts a request", async () => {
    const output = quietConsole();

    await import("../index");

    expect(output.info).not.toHaveBeenCalled();
    expect(output.table).not.toHaveBeenCalled();
    expect(output.error).not.toHaveBeenCalled();
  });
});

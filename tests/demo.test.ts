import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemo } from "../examples/demo";
import { OfferRepository } from "../src/storage/OfferRepository";

const directories: string[] = [];
const now = new Date("2026-10-28T12:00:00.000Z");

function demoPath(name = "demo.sqlite"): string {
  const directory = mkdtempSync(join(tmpdir(), "wakacje-offline-demo-"));
  directories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("offline demo", () => {
  test("creates synthetic history and comparable prices without making requests", () => {
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("The offline demo must not call fetch"));
    try {
      const result = createDemo(demoPath(), now);
      expect(fetch).not.toHaveBeenCalled();
      expect(result.stats).toEqual({ runs: 2, observations: 12, comparisonGroups: 6, rejected: 0 });
      expect(result.ranked).toHaveLength(6);
      expect(result.ranked[0]?.observation.offer).toMatchObject({
        name: "Synthetic Hotel 1", priceMinor: 240_000,
        startDate: "2026-11-11", endDate: "2026-11-18", adults: 2,
      });
      expect(result.ranked[0]?.belowMedianPercent).toBeCloseTo(25);
      expect(result.ranked[0]?.peerHotels).toBe(5);
      const repository = new OfferRepository(result.databasePath);
      try {
        expect(repository.getLatest().every(({ rawJson }) => {
          const raw: unknown = JSON.parse(rawJson);
          return typeof raw === "object" && raw !== null && "synthetic" in raw && raw.synthetic === true;
        })).toBe(true);
      } finally {
        repository.close();
      }
    } finally {
      fetch.mockRestore();
    }
  });

  test("refuses to create or modify a production database path", () => {
    const path = demoPath("offers.sqlite");
    writeFileSync(path, "existing user database");
    expect(() => createDemo(path, now)).toThrow("only creates a new file named demo.sqlite");
    expect(readFileSync(path, "utf8")).toBe("existing user database");
  });

  test("refuses to open an existing SQLite file even when it is named demo.sqlite", () => {
    const path = demoPath();
    const database = new Database(path);
    database.run("CREATE TABLE user_data (value TEXT)");
    database.run("INSERT INTO user_data VALUES ('preserve me')");
    database.close();
    const before = readFileSync(path);
    expect(() => createDemo(path, now)).toThrow("Refusing to overwrite");
    expect(readFileSync(path)).toEqual(before);
  });

  test("leaves the generated database unchanged on a repeated run", () => {
    const path = demoPath();
    createDemo(path, now);
    const before = readFileSync(path);
    expect(() => createDemo(path, now)).toThrow("Refusing to overwrite");
    expect(readFileSync(path)).toEqual(before);
  });

  test("preserves orphaned SQLite sidecars without creating the database", () => {
    const path = demoPath();
    writeFileSync(`${path}-wal`, "existing journal");
    expect(() => createDemo(path, now)).toThrow("existing SQLite sidecar files");
    expect(readFileSync(`${path}-wal`, "utf8")).toBe("existing journal");
    expect(existsSync(path)).toBe(false);
  });
});

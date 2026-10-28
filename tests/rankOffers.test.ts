import { describe, expect, test } from "bun:test";
import { getOfferTransport, rankOffers } from "../src/offers/rankOffers";
import type { NormalizedOffer, StoredOffer } from "../src/offers/types";

function observation(
  id: number,
  offer: Partial<NormalizedOffer> = {},
  metadata: Partial<Omit<StoredOffer, "offer" | "id">> = {},
): StoredOffer {
  return {
    id,
    runId: "run-example",
    profile: "last-minute",
    observedAt: "2026-10-16T12:00:00.000Z",
    sourceUrl: "https://example.test/offers",
    rawJson: JSON.stringify({ transport: { id: 1, unifiedName: "samolotem" } }),
    ...metadata,
    offer: {
      snapshotKey: `snapshot-${id}`,
      comparisonKey: `comparison-${id}`,
      sourceId: id,
      hotelId: id,
      name: `Hotel ${id}`,
      country: "Example country",
      countryCode: "EX",
      region: "Example region",
      departureId: 1,
      departure: "Example airport",
      startDate: "2026-11-10",
      endDate: "2026-11-17",
      nights: 7,
      cateringId: 1,
      catering: "All Inclusive",
      providerCode: "example",
      provider: "Example provider",
      roomId: null,
      stars: 4,
      rating: 8,
      priceMinor: 280_000,
      currency: "PLN",
      priceType: "total",
      adults: 2,
      children: 0,
      sourceHash: `hash-${id}`,
      ...offer,
    },
  };
}

const dateOptions = { asOfDate: "2026-10-16" };

describe("rankOffers", () => {
  test("sorts total prices ascending and ratings descending for ties without mutating input", () => {
    const offers = [
      observation(1, { priceMinor: 400_000 }),
      observation(2, { priceMinor: 200_000, rating: 7 }),
      observation(3, { priceMinor: 200_000, rating: 9 }),
    ];

    const ranked = rankOffers(offers, dateOptions);

    expect(ranked.map(({ observation: value }) => value.id)).toEqual([3, 2, 1]);
    expect(ranked[0]?.pricePerPersonNightMinor).toBe(200_000 / 14);
    expect(offers.map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  test("uses the latest observation across profiles, breaking equal times by database id", () => {
    const offers = [
      observation(3, { comparisonKey: "same", priceMinor: 350_000 }, { profile: "all-inclusive" }),
      observation(1, { comparisonKey: "same", priceMinor: 100_000 }, { observedAt: "2026-10-15T12:00:00.000Z" }),
      observation(2, { comparisonKey: "same", priceMinor: 250_000 }),
    ];

    const ranked = rankOffers(offers, dateOptions);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.observation.id).toBe(3);
    expect(ranked[0]?.observation.offer.priceMinor).toBe(350_000);
  });

  test("compares observation instants rather than timestamp string order", () => {
    const older = observation(2, { comparisonKey: "same" }, { observedAt: "2026-10-16T14:00:00+02:00" });
    const newer = observation(1, { comparisonKey: "same" }, { observedAt: "2026-10-16T12:01:00Z" });

    expect(rankOffers([older, newer], dateOptions)[0]?.observation.id).toBe(1);
  });

  test("keeps only future PLN totals for two adults without children", () => {
    const offers = [
      observation(1),
      observation(2, { currency: "EUR" }),
      observation(3, { adults: 1 }),
      observation(4, { children: 1 }),
      observation(5, { startDate: "2026-10-15" }),
      observation(6, { startDate: "2026-10-16" }),
      observation(7, { startDate: "2026-11-31" }),
      observation(8, { nights: 0 }),
      observation(9, { nights: 1.5 }),
      observation(10, { priceMinor: 0 }),
      observation(11, { priceMinor: Number.NaN }),
      observation(12, {}, { observedAt: "invalid" }),
    ];

    expect(rankOffers(offers, dateOptions).map(({ observation: value }) => value.id)).toEqual([1, 6]);
  });

  test("qualityOnly requires both rating at least eight and at least four stars", () => {
    const offers = [
      observation(1, { rating: 8, stars: 4, priceMinor: 300_000 }),
      observation(2, { rating: 7.9, stars: 5 }),
      observation(3, { rating: 9, stars: 3.5 }),
      observation(4, { rating: null, stars: 5 }),
      observation(5, { rating: 9, stars: null }),
      observation(6, { rating: 9, stars: 5, priceMinor: 200_000 }),
    ];

    expect(rankOffers(offers, { ...dateOptions, qualityOnly: true }).map(({ observation: value }) => value.id))
      .toEqual([6, 1]);
  });

  test("leaves the peer comparison unavailable with fewer than five other hotels", () => {
    const offers = Array.from({ length: 5 }, (_, index) => observation(index + 1));
    const ranked = rankOffers(offers, dateOptions);

    expect(ranked[0]?.peerHotels).toBe(4);
    expect(ranked[0]?.peerMedianMinor).toBeNull();
    expect(ranked[0]?.belowMedianPercent).toBeNull();
  });

  test("uses five distinct other hotels and excludes the candidate hotel from its median", () => {
    const offers = [
      observation(1, { priceMinor: 140_000 }),
      ...[280_000, 420_000, 560_000, 700_000, 840_000].map((priceMinor, index) => observation(index + 2, { priceMinor })),
    ];
    const ranked = rankOffers(offers, dateOptions);

    expect(ranked[0]?.peerHotels).toBe(5);
    expect(ranked[0]?.pricePerPersonNightMinor).toBe(10_000);
    expect(ranked[0]?.peerMedianMinor).toBe(40_000);
    expect(ranked[0]?.belowMedianPercent).toBe(75);
    expect(ranked.at(-1)?.belowMedianPercent).toBeLessThan(0);
  });

  test("takes one median per hotel so many variants do not outweigh other hotels", () => {
    const offers = [
      observation(1, { priceMinor: 140_000 }),
      observation(2, { priceMinor: 140_000 }),
      observation(3, { hotelId: 2, priceMinor: 420_000 }),
      observation(4, { hotelId: 2, priceMinor: 1_400_000 }),
      observation(5, { priceMinor: 560_000 }),
      observation(6, { priceMinor: 700_000 }),
      observation(7, { priceMinor: 840_000 }),
      observation(8, { priceMinor: 980_000 }),
      observation(9, { hotelId: 1, priceMinor: 1_400_000 }),
    ];
    const candidate = rankOffers(offers, dateOptions).find(({ observation: value }) => value.id === 1);

    expect(candidate?.peerHotels).toBe(5);
    expect(candidate?.peerMedianMinor).toBe(50_000);
    expect(candidate?.belowMedianPercent).toBe(80);
  });

  test("averages the middle hotel prices when the peer count is even", () => {
    const offers = Array.from({ length: 7 }, (_, index) => observation(index + 1, { priceMinor: 140_000 * (index + 1) }));

    const candidate = rankOffers(offers, dateOptions)[0];

    expect(candidate?.peerHotels).toBe(6);
    expect(candidate?.peerMedianMinor).toBe(45_000);
  });

  test.each([
    { countryCode: "OTHER" },
    { cateringId: 2 },
    { nights: 8 },
    { stars: 5 },
    { departureId: 2 },
    { startDate: "2026-12-10" },
  ] satisfies Partial<NormalizedOffer>[])("separates comparison cohorts by %j", (different) => {
    const candidate = observation(1);
    const differentHotels = Array.from({ length: 5 }, (_, index) => observation(index + 2, different));

    const ranked = rankOffers([candidate, ...differentHotels], dateOptions);
    const result = ranked.find(({ observation: value }) => value.id === 1);

    expect(result?.peerHotels).toBe(0);
    expect(result?.peerMedianMinor).toBeNull();
  });

  test("quality and display limits do not shrink the benchmark sample", () => {
    const offers = [
      observation(1, { priceMinor: 140_000, rating: 9 }),
      ...Array.from({ length: 5 }, (_, index) => observation(index + 2, { priceMinor: 280_000, rating: 7 })),
    ];

    const ranked = rankOffers(offers, { ...dateOptions, limit: 1, qualityOnly: true });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.peerHotels).toBe(5);
    expect(ranked[0]?.peerMedianMinor).toBe(20_000);
  });

  test("keeps flight and self-drive price benchmarks separate", () => {
    const flights = Array.from({ length: 6 }, (_, index) => observation(index + 1));
    const selfDrive = Array.from({ length: 6 }, (_, index) => observation(index + 7, { priceMinor: 140_000 }, {
      rawJson: JSON.stringify({ transport: { id: 3, unifiedName: "własny" } }),
    }));

    const ranked = rankOffers([...flights, ...selfDrive], dateOptions);
    const flight = ranked.find(({ observation: value }) => value.id === 1);
    const drive = ranked.find(({ observation: value }) => value.id === 7);

    expect(flight?.peerHotels).toBe(5);
    expect(flight?.peerMedianMinor).toBe(20_000);
    expect(drive?.peerHotels).toBe(5);
    expect(drive?.peerMedianMinor).toBe(10_000);
    expect(getOfferTransport(selfDrive[0] ?? observation(100))).toEqual({ id: 3, label: "własny" });
  });

  test("missing transport metadata neither creates nor contributes to peer claims", () => {
    const flights = Array.from({ length: 5 }, (_, index) => observation(index + 1));
    const unknown = Array.from({ length: 6 }, (_, index) => observation(index + 6, {}, { rawJson: "{}" }));

    const ranked = rankOffers([...flights, ...unknown], dateOptions);

    for (const result of ranked) {
      expect(result.peerMedianMinor).toBeNull();
      expect(result.belowMedianPercent).toBeNull();
      expect(result.peerHotels).toBe(result.observation.id < 6 ? 4 : 0);
    }
  });

  test("extracts transport labels from source metadata without inventing defaults", () => {
    expect(getOfferTransport({ rawJson: '{"transport":{"id":1,"unifiedName":" samolotem "}}' }))
      .toEqual({ id: 1, label: "samolotem" });
    for (const rawJson of [
      "invalid JSON",
      "null",
      "[]",
      "{}",
      '{"transport":null}',
      '{"transport":[]}',
      '{"transport":{"id":1}}',
      '{"transport":{"id":"1","unifiedName":"samolotem"}}',
      '{"transport":{"id":0,"unifiedName":"samolotem"}}',
      '{"transport":{"id":1.5,"unifiedName":"samolotem"}}',
      '{"transport":{"id":1,"unifiedName":" "}}',
    ]) {
      expect(getOfferTransport({ rawJson })).toBeNull();
    }
  });

  test("does not count duplicate profile observations as more peer hotels", () => {
    const offers = Array.from({ length: 5 }, (_, index) => observation(index + 1));
    const duplicated = offers.map((value) => ({ ...value, id: value.id + 100, profile: "all-inclusive" as const }));

    const ranked = rankOffers([...offers, ...duplicated], dateOptions);

    expect(ranked).toHaveLength(5);
    expect(ranked[0]?.peerHotels).toBe(4);
    expect(ranked[0]?.peerMedianMinor).toBeNull();
  });

  test("handles empty input and validates limits and departure cutoffs", () => {
    expect(rankOffers([], dateOptions)).toEqual([]);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rankOffers([], { ...dateOptions, limit })).toThrow(RangeError);
    }
    for (const asOfDate of ["invalid", "2026-02-30", "2026-1-01"]) {
      expect(() => rankOffers([], { asOfDate })).toThrow(TypeError);
    }
  });
});

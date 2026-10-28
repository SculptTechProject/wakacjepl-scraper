import { describe, expect, test } from "bun:test";
import { normalizeOffer } from "../src/offers/normalizeOffer";

const context = { adultCount: 2, childCount: 0 };

// Minimal synthetic fixture matching the observed public offers response.
function fixture() {
  return {
    id: 42,
    label: "Example Resort",
    hash: "source-offer-hash",
    object: { id: 100, category: 4 },
    localisation: {
      country: { name: "Egipt", iso2Code: "EG" },
      region: { name: "Marsa El Alam" },
    },
    departure: { id: 2622, label: "Katowice" },
    transport: { startDate: "2026-10-23", endDate: "2026-10-31", nights: 7 },
    catering: { id: 1, label: "All Inclusive" },
    provider: { code: "EXAMPLE", label: "Example Travel" },
    roomId: "",
    rating: { value: 8.5 },
    price: { type: "total", currency: "PLN", value: 2970 },
  };
}

describe("normalizeOffer", () => {
  test("maps the observed listing fields and stores the total price in minor units", () => {
    const offer = normalizeOffer(fixture(), context);

    expect(offer).toMatchObject({
      sourceId: 42,
      hotelId: 100,
      name: "Example Resort",
      country: "Egipt",
      countryCode: "EG",
      region: "Marsa El Alam",
      departureId: 2622,
      departure: "Katowice",
      startDate: "2026-10-23",
      endDate: "2026-10-31",
      nights: 7,
      cateringId: 1,
      catering: "All Inclusive",
      providerCode: "EXAMPLE",
      provider: "Example Travel",
      roomId: null,
      stars: 4,
      rating: 8.5,
      priceMinor: 297000,
      priceType: "total",
      currency: "PLN",
      adults: 2,
      children: 0,
      sourceHash: "source-offer-hash",
    });
    expect(offer.snapshotKey).toMatch(/^[a-f0-9]{64}$/);
    expect(offer.comparisonKey).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    [1.005, 101],
    [10.075, 1008],
    [19.99, 1999],
    [1234.567, 123457],
    [1e-2, 1],
  ])("rounds %s in major units to %s in minor units", (value, expected) => {
    const source = fixture();
    source.price.value = value;

    expect(normalizeOffer(source, context).priceMinor).toBe(expected);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 0.001])(
    "rejects an invalid or unsafe price %s",
    (value) => {
      const source = fixture();
      source.price.value = value;

      expect(() => normalizeOffer(source, context)).toThrow(TypeError);
    },
  );

  test.each(["person", "from", "TOTAL", ""])("rejects price type %s", (type) => {
    const source = fixture();
    source.price.type = type;

    expect(() => normalizeOffer(source, context)).toThrow(TypeError);
  });

  test.each(["pln", "PL", "PLNN", "12$"])("rejects malformed currency %s", (currency) => {
    const source = fixture();
    source.price.currency = currency;

    expect(() => normalizeOffer(source, context)).toThrow(TypeError);
  });

  test.each([
    { label: "missing", code: undefined },
    { label: "null", code: null },
  ])("preserves a country name with an unavailable $label ISO code without guessing one", ({ code }) => {
    const source = fixture();
    const country = { name: "Etiopia", ...(code === undefined ? {} : { iso2Code: code }) };

    const offer = normalizeOffer({
      ...source, localisation: { ...source.localisation, country },
    }, context);

    expect(offer.country).toBe("Etiopia");
    expect(offer.countryCode).toBe("");
  });

  test.each(["", " ", "eg", "EGY", 42])("rejects a malformed provided country ISO code %j", (iso2Code) => {
    const source = fixture();

    expect(() => normalizeOffer({
      ...source,
      localisation: {
        ...source.localisation,
        country: { ...source.localisation.country, iso2Code },
      },
    }, context)).toThrow(TypeError);
  });

  test("allows missing optional scores and an empty region", () => {
    const source = fixture();
    const { rating: _rating, object, ...withoutRating } = source;
    const { category: _category, ...withoutCategory } = object;
    const offer = normalizeOffer({
      ...withoutRating,
      object: withoutCategory,
      localisation: { ...source.localisation, region: { name: "" } },
    }, context);

    expect(offer.rating).toBeNull();
    expect(offer.stars).toBeNull();
    expect(offer.region).toBe("");
  });

  test("preserves zero optional scores and converts explicit null scores to null", () => {
    const source = fixture();
    expect(normalizeOffer({ ...source, rating: { value: 0 }, object: { id: 100, category: 0 } }, context))
      .toMatchObject({ rating: 0, stars: 0 });
    expect(normalizeOffer({ ...source, rating: null, object: { id: 100, category: null } }, context))
      .toMatchObject({ rating: null, stars: null });
  });

  test.each(["8.5", -1, 10.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed optional rating %s",
    (value) => {
      expect(() => normalizeOffer({ ...fixture(), rating: { value } }, context)).toThrow(TypeError);
    },
  );

  test.each([5.1, 5.5, 6, 10])("preserves hotel categories above five on the source's own scale: %s", (category) => {
    expect(normalizeOffer({ ...fixture(), object: { id: 100, category } }, context).stars).toBe(category);
  });

  test.each(["4", -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects malformed optional hotel category %s",
    (category) => {
      expect(() => normalizeOffer({ ...fixture(), object: { id: 100, category } }, context))
        .toThrow(TypeError);
    },
  );

  test.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-1-01", "invalid"])(
    "rejects impossible or malformed calendar date %s",
    (startDate) => {
      const source = fixture();
      source.transport.startDate = startDate;

      expect(() => normalizeOffer(source, context)).toThrow(TypeError);
    },
  );

  test("accepts a real leap day without deriving hotel nights from flight dates", () => {
    const source = fixture();
    source.transport = { startDate: "2028-02-29", endDate: "2028-03-08", nights: 7 };

    expect(normalizeOffer(source, context)).toMatchObject({
      startDate: "2028-02-29",
      endDate: "2028-03-08",
      nights: 7,
    });
  });

  test.each(["2026-10-22", "2026-10-23"])("rejects unordered end date %s", (endDate) => {
    const source = fixture();
    source.transport.endDate = endDate;

    expect(() => normalizeOffer(source, context)).toThrow(TypeError);
  });

  test("preserves zero overnight stays for a tour whose travel spans two dates", () => {
    const source = fixture();
    const offer = normalizeOffer({
      ...source,
      label: "Example Christmas Market Tour",
      object: { ...source.object, category: 0, type: { id: 2, unifiedName: "zwiedzanie" } },
      transport: { ...source.transport, startDate: "2026-12-12", endDate: "2026-12-13", nights: 0 },
    }, context);

    expect(offer.nights).toBe(0);
    expect(offer.startDate).toBe("2026-12-12");
    expect(offer.endDate).toBe("2026-12-13");
  });

  test("accepts same-day travel only when the source advertises zero overnight stays", () => {
    const source = fixture();
    const offer = normalizeOffer({
      ...source,
      label: "Example Same-Day Christmas Market Trip",
      transport: { ...source.transport, startDate: "2026-12-12", endDate: "2026-12-12", nights: 0 },
    }, context);

    expect(offer).toMatchObject({ startDate: "2026-12-12", endDate: "2026-12-12", nights: 0 });
  });

  test("rejects travel ending before it starts even when there are zero overnight stays", () => {
    const source = fixture();

    expect(() => normalizeOffer({
      ...source,
      transport: { ...source.transport, startDate: "2026-12-13", endDate: "2026-12-12", nights: 0 },
    }, context)).toThrow(TypeError);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid hotel nights %s", (nights) => {
    const source = fixture();
    source.transport.nights = nights;

    expect(() => normalizeOffer(source, context)).toThrow(TypeError);
  });

  test("keeps comparison groups stable as price, source hash, and rating change", () => {
    const original = fixture();
    const changed = {
      ...original,
      hash: "updated-source-hash",
      price: { ...original.price, value: 3100 },
      rating: { value: 9 },
    };
    const before = normalizeOffer(original, context);
    const after = normalizeOffer(changed, context);

    expect(before.comparisonKey).toBe(after.comparisonKey);
    expect(before.snapshotKey).not.toBe(after.snapshotKey);
    expect(normalizeOffer(original, context).snapshotKey).toBe(before.snapshotKey);
  });

  test("includes travelers and room identifiers in the comparison identity", () => {
    const source = fixture();
    const original = normalizeOffer(source, context);
    const adults = normalizeOffer(source, { adultCount: 3, childCount: 0 });
    const children = normalizeOffer(source, { adultCount: 2, childCount: 1 });
    const room = normalizeOffer({ ...source, roomId: "room-double" }, context);

    expect(adults.comparisonKey).not.toBe(original.comparisonKey);
    expect(children.comparisonKey).not.toBe(original.comparisonKey);
    expect(room.comparisonKey).not.toBe(original.comparisonKey);
    expect(room.roomId).toBe("room-double");
  });

  test("includes departure, provider, hotel, board, dates, and source ID in comparison identity", () => {
    const source = fixture();
    const original = normalizeOffer(source, context).comparisonKey;
    const alternatives: unknown[] = [
      { ...source, id: 43 },
      { ...source, object: { ...source.object, id: 101 } },
      { ...source, provider: { ...source.provider, code: "OTHER" } },
      { ...source, departure: { ...source.departure, id: 10 } },
      { ...source, catering: { ...source.catering, id: 2 } },
      { ...source, transport: { ...source.transport, startDate: "2026-10-24" } },
      { ...source, transport: { ...source.transport, endDate: "2026-11-01" } },
      { ...source, transport: { ...source.transport, nights: 8 } },
    ];

    for (const alternative of alternatives) {
      expect(normalizeOffer(alternative, context).comparisonKey).not.toBe(original);
    }
  });

  test.each([
    { adultCount: 0, childCount: 0 },
    { adultCount: -1, childCount: 0 },
    { adultCount: 1.5, childCount: 0 },
    { adultCount: 2, childCount: -1 },
    { adultCount: 2, childCount: 0.5 },
  ])("rejects invalid traveler context %j", (invalidContext) => {
    expect(() => normalizeOffer(fixture(), invalidContext)).toThrow(TypeError);
  });

  test.each([
    ["null", null],
    ["array", []],
    ["missing fields", {}],
    ["negative ID", { ...fixture(), id: -1 }],
    ["empty name", { ...fixture(), label: " " }],
    ["empty source hash", { ...fixture(), hash: "" }],
  ] satisfies [string, unknown][])(
    "rejects malformed required data: %s",
    (_label, value) => {
      expect(() => normalizeOffer(value, context)).toThrow(TypeError);
    },
  );

  test("does not include untrusted source values in error messages", () => {
    const source = fixture();
    const error = (() => {
      try {
        normalizeOffer({ ...source, price: { ...source.price, type: "private-source-marker" } }, context);
      } catch (cause) {
        return cause;
      }
      throw new Error("Expected validation to fail");
    })();

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("private-source-marker");
  });
});

import { createHash } from "node:crypto";
import type { NormalizedOffer } from "./types";

interface NormalizationContext {
  readonly adultCount: number;
  readonly childCount: number;
}

function invalid(field: string): never {
  throw new TypeError(`Invalid offer field: ${field}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(field);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") return invalid(field);
  const result = value.trim();
  if (!allowEmpty && result.length === 0) return invalid(field);
  return result;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return invalid(field);
  }
  return value;
}

function optionalScore(value: unknown, field: string, maximum?: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0
    || (maximum !== undefined && value > maximum)) {
    return invalid(field);
  }
  return value;
}

function calendarDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return invalid(field);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return invalid(field);
  }
  return value;
}

function priceInMinorUnits(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return invalid("price.value");
  }
  // Shift the decimal exponent before rounding: 10.075 * 100 is below 1007.5 in IEEE 754.
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const minor = Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
  if (!Number.isSafeInteger(minor) || minor <= 0) return invalid("price.value");
  return minor;
}

function key(values: readonly (string | number | null)[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** Normalize the observed public listing schema; raw source JSON is stored separately. */
export function normalizeOffer(value: unknown, context: NormalizationContext): NormalizedOffer {
  const adults = integer(context.adultCount, "context.adultCount", 1);
  const children = integer(context.childCount, "context.childCount");
  const source = record(value, "offer");
  const hotel = record(source["object"], "object");
  const localisation = record(source["localisation"], "localisation");
  const country = record(localisation["country"], "localisation.country");
  const region = record(localisation["region"], "localisation.region");
  const departure = record(source["departure"], "departure");
  const transport = record(source["transport"], "transport");
  const catering = record(source["catering"], "catering");
  const provider = record(source["provider"], "provider");
  const price = record(source["price"], "price");

  const sourceId = integer(source["id"], "id");
  const hotelId = integer(hotel["id"], "object.id");
  const sourceHash = text(source["hash"], "hash");
  const departureId = integer(departure["id"], "departure.id");
  const startDate = calendarDate(transport["startDate"], "transport.startDate");
  const endDate = calendarDate(transport["endDate"], "transport.endDate");
  // Flight dates can span more calendar days than the advertised hotel nights.
  const nights = integer(transport["nights"], "transport.nights");
  if (endDate < startDate || (endDate === startDate && nights !== 0)) {
    return invalid("transport.endDate");
  }
  const cateringId = integer(catering["id"], "catering.id");
  const providerCode = text(provider["code"], "provider.code");
  const roomId = text(source["roomId"], "roomId", true) || null;
  const currency = text(price["currency"], "price.currency");
  if (!/^[A-Z]{3}$/.test(currency)) return invalid("price.currency");
  const priceType = price["type"];
  if (priceType !== "total") return invalid("price.type");
  const sourceCountryCode = country["iso2Code"];
  const countryCode = sourceCountryCode === undefined || sourceCountryCode === null
    ? ""
    : text(sourceCountryCode, "localisation.country.iso2Code");
  if (countryCode !== "" && !/^[A-Z]{2}$/.test(countryCode)) {
    return invalid("localisation.country.iso2Code");
  }

  const ratingSource = source["rating"];
  const rating = ratingSource === undefined || ratingSource === null
    ? null
    : optionalScore(record(ratingSource, "rating")["value"], "rating.value", 10);

  return {
    snapshotKey: key([sourceId, sourceHash]),
    // This groups visible listings, not guaranteed identical rooms when roomId is unavailable.
    comparisonKey: key([
      sourceId, hotelId, providerCode, departureId, startDate, endDate, nights,
      cateringId, roomId, adults, children, currency, priceType,
    ]),
    sourceId,
    hotelId,
    name: text(source["label"], "label"),
    country: text(country["name"], "localisation.country.name"),
    countryCode,
    region: text(region["name"], "localisation.region.name", true),
    departureId,
    departure: text(departure["label"], "departure.label"),
    startDate,
    endDate,
    nights,
    cateringId,
    catering: text(catering["label"], "catering.label"),
    providerCode,
    provider: text(provider["label"], "provider.label"),
    roomId,
    // Preserve the source's local category scale, which includes values above five.
    stars: optionalScore(hotel["category"], "object.category"),
    rating,
    priceMinor: priceInMinorUnits(price["value"]),
    currency,
    priceType,
    adults,
    children,
    sourceHash,
  };
}

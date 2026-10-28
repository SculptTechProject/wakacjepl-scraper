import type { StoredOffer } from "./types";

export interface RankOffersOptions {
  readonly limit?: number;
  readonly qualityOnly?: boolean;
  /** Departure cutoff as YYYY-MM-DD; defaults to today's UTC date. */
  readonly asOfDate?: string;
}

export interface RankedOffer {
  readonly observation: StoredOffer;
  readonly pricePerPersonNightMinor: number;
  readonly peerMedianMinor: number | null;
  readonly belowMedianPercent: number | null;
  readonly peerHotels: number;
}

export interface OfferTransport {
  readonly id: number;
  readonly label: string;
}

/** Reads the source transport without guessing a mode when metadata is missing. */
export function getOfferTransport(observation: Pick<StoredOffer, "rawJson">): OfferTransport | null {
  let source: unknown;
  try {
    source = JSON.parse(observation.rawJson);
  } catch {
    return null;
  }
  if (typeof source !== "object" || source === null || Array.isArray(source) || !("transport" in source)) {
    return null;
  }
  const transport: unknown = source.transport;
  if (
    typeof transport !== "object"
    || transport === null
    || Array.isArray(transport)
    || !("id" in transport)
    || typeof transport.id !== "number"
    || !Number.isSafeInteger(transport.id)
    || transport.id < 1
    || !("unifiedName" in transport)
    || typeof transport.unifiedName !== "string"
    || transport.unifiedName.trim().length === 0
  ) {
    return null;
  }
  return { id: transport.id, label: transport.unifiedName.trim() };
}

interface HotelMedian {
  readonly hotelId: number;
  readonly price: number;
}

interface PeerBenchmark {
  readonly peerHotels: number;
  readonly median: number | null;
}

const minimumPeerHotels = 5;

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new RangeError("Median requires a nonempty sample");
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new RangeError("Median requires a nonempty sample");
  return (lower + upper) / 2;
}

function cohortKey({ offer }: StoredOffer, transportId: number): string {
  return JSON.stringify([
    offer.countryCode || offer.country,
    offer.cateringId,
    offer.nights,
    offer.stars,
    offer.departureId,
    offer.startDate.slice(0, 7),
    offer.adults,
    offer.children,
    offer.currency,
    offer.priceType,
    transportId,
  ]);
}

function pricePerPersonNight({ offer }: StoredOffer): number {
  return offer.priceMinor / (offer.adults * offer.nights);
}

function latestObservations(offers: readonly StoredOffer[]): readonly StoredOffer[] {
  const latest = new Map<string, StoredOffer>();
  for (const observation of offers) {
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt)) continue;
    const previous = latest.get(observation.offer.comparisonKey);
    const previousTime = previous ? Date.parse(previous.observedAt) : Number.NEGATIVE_INFINITY;
    if (
      observedAt > previousTime
      || (observedAt === previousTime && previous !== undefined && observation.id > previous.id)
    ) {
      latest.set(observation.offer.comparisonKey, observation);
    }
  }
  return [...latest.values()];
}

function medianExcluding(hotels: readonly HotelMedian[], excludedIndex: number): number | null {
  const count = hotels.length - 1;
  if (count < minimumPeerHotels) return null;
  const remainingPrice = (index: number) => hotels[index >= excludedIndex ? index + 1 : index]?.price;
  const lower = remainingPrice(Math.floor((count - 1) / 2));
  const upper = remainingPrice(Math.floor(count / 2));
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2;
}

function benchmarks(
  offers: readonly StoredOffer[],
  cohortKeys: ReadonlyMap<StoredOffer, string>,
): ReadonlyMap<string, ReadonlyMap<number, PeerBenchmark>> {
  const cohorts = new Map<string, Map<number, number[]>>();
  for (const observation of offers) {
    const key = cohortKeys.get(observation);
    if (key === undefined) continue;
    let hotels = cohorts.get(key);
    if (!hotels) {
      hotels = new Map<number, number[]>();
      cohorts.set(key, hotels);
    }
    const hotelId = observation.offer.hotelId;
    const prices = hotels.get(hotelId);
    if (prices) prices.push(pricePerPersonNight(observation));
    else hotels.set(hotelId, [pricePerPersonNight(observation)]);
  }

  const result = new Map<string, ReadonlyMap<number, PeerBenchmark>>();
  for (const [key, hotels] of cohorts) {
    // One median per hotel prevents hotels with many room variants dominating the sample.
    const medians = [...hotels].map(([hotelId, prices]) => ({ hotelId, price: median(prices) }))
      .sort((left, right) => left.price - right.price || left.hotelId - right.hotelId);
    const byHotel = new Map<number, PeerBenchmark>();
    medians.forEach((hotel, index) => {
      byHotel.set(hotel.hotelId, {
        peerHotels: medians.length - 1,
        median: medianExcluding(medians, index),
      });
    });
    result.set(key, byHotel);
  }
  return result;
}

/**
 * Rule baseline for currently recorded PLN totals for two adults.
 * Peer differences describe this sample only, not a historical discount or ML score.
 * Comparison keys with unknown rooms do not establish identical package identity.
 */
export function rankOffers(
  offers: readonly StoredOffer[],
  options: RankOffersOptions = {},
): readonly RankedOffer[] {
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  if (!isDateOnly(asOfDate)) throw new TypeError("asOfDate must be a valid YYYY-MM-DD date");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new RangeError("limit must be a positive safe integer");
  }

  const eligible = latestObservations(offers).filter(({ offer }) => {
    const startDate = offer.startDate.slice(0, 10);
    return offer.currency === "PLN"
      && offer.priceType === "total"
      && offer.adults === 2
      && offer.children === 0
      && Number.isSafeInteger(offer.nights)
      && offer.nights >= 1
      && Number.isSafeInteger(offer.priceMinor)
      && offer.priceMinor > 0
      && isDateOnly(startDate)
      && startDate >= asOfDate;
  });
  const cohortKeys = new Map<StoredOffer, string>();
  for (const observation of eligible) {
    const transport = getOfferTransport(observation);
    if (transport) cohortKeys.set(observation, cohortKey(observation, transport.id));
  }
  const peers = benchmarks(eligible, cohortKeys);
  const ranked: RankedOffer[] = eligible
    .filter(({ offer }) => !options.qualityOnly || (
      offer.rating !== null && offer.rating >= 8 && offer.stars !== null && offer.stars >= 4
    ))
    .sort((left, right) => left.offer.priceMinor - right.offer.priceMinor
      || (right.offer.rating ?? -1) - (left.offer.rating ?? -1)
      || left.id - right.id)
    .map((observation) => {
      const price = pricePerPersonNight(observation);
      const key = cohortKeys.get(observation);
      const benchmark = key === undefined ? undefined : peers.get(key)?.get(observation.offer.hotelId);
      const peerMedian = benchmark?.median ?? null;
      return {
        observation,
        pricePerPersonNightMinor: price,
        peerMedianMinor: peerMedian,
        belowMedianPercent: peerMedian === null ? null : 100 * (peerMedian - price) / peerMedian,
        peerHotels: benchmark?.peerHotels ?? 0,
      };
    });
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}

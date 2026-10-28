import type { CookieJar } from "tough-cookie";
import { HttpClient } from "../http/HttpClient";
import type { HttpResponse } from "../http/types";

export interface WakacjeClientOptions {
  readonly authorization: string;
  readonly deviceId: string;
  readonly cookieJar?: CookieJar;
}

export interface OfferListingOptions {
  readonly adultCount?: number;
  readonly childCount?: number;
  readonly imageLimit?: number;
  readonly limit?: number;
  readonly promotionList?: readonly number[];
  readonly cateringList?: readonly number[];
  readonly destinationCountry?: readonly number[];
  readonly transportType?: readonly number[];
  readonly offerType?: readonly number[];
  readonly providerList?: readonly number[];
  readonly order?: 1 | 11 | 13;
  readonly cursor?: string;
}

export interface DestinationCountry {
  readonly id: number;
  readonly label: string;
  readonly iso2Code: string | null;
}

export interface TravelProvider {
  readonly id: number;
  readonly label: string;
}

export interface OfferListing {
  readonly data: readonly unknown[];
  readonly meta?: {
    readonly cursor?: string | null;
    readonly total?: number;
    readonly count?: number;
  };
}

function isHeaderValue(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim() === value
    && /^[\x20-\x7e]+$/.test(value);
}

function requireInteger(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

function requireIdentifiers(values: readonly number[], name: string): void {
  if (!Array.isArray(values)) {
    throw new TypeError(`${name} must be an array of integer identifiers`);
  }
  for (const value of values) requireInteger(value, 0, `${name} item`);
}

function isOfferListing(value: unknown): value is OfferListing {
  if (!(typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "data" in value
    && Array.isArray(value.data))) return false;
  if (!("meta" in value)) return true;
  const meta = value.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return false;
  if ("cursor" in meta && meta.cursor !== null && typeof meta.cursor !== "string") return false;
  for (const key of ["total", "count"] as const) {
    if (key in meta) {
      const count: unknown = Reflect.get(meta, key);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDestinations(value: unknown): readonly DestinationCountry[] {
  if (!isRecord(value) || !Array.isArray(value["data"])) {
    throw new TypeError("Invalid Wakacje destinations response");
  }
  const countries = new Map<number, DestinationCountry>();
  for (const group of value["data"]) {
    if (!isRecord(group) || group["form"] !== "destinationCountry" || !Array.isArray(group["data"])) {
      throw new TypeError("Invalid Wakacje destination country group");
    }
    for (const item of group["data"]) {
      if (!isRecord(item)) throw new TypeError("Invalid Wakacje destination country");
      const id = item["value"];
      const label = item["label"];
      const iso2Code = item["iso2Code"];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0
        || typeof label !== "string" || label.trim().length === 0
        || (iso2Code !== undefined && iso2Code !== null
          && (typeof iso2Code !== "string" || !/^[A-Z]{2}$/.test(iso2Code)))) {
        throw new TypeError("Invalid Wakacje destination country");
      }
      // Featured countries are repeated in the complete alphabetical group.
      countries.set(id, {
        id,
        label: label.trim(),
        iso2Code: iso2Code ?? countries.get(id)?.iso2Code ?? null,
      });
    }
  }
  if (countries.size === 0) throw new TypeError("Empty Wakacje destinations catalog");
  return [...countries.values()];
}

function parseProviders(value: unknown): readonly TravelProvider[] {
  if (!isRecord(value) || !Array.isArray(value["data"])) {
    throw new TypeError("Invalid Wakacje filters response");
  }
  const providers = new Map<number, TravelProvider>();
  for (const group of value["data"]) {
    if (!isRecord(group)) throw new TypeError("Invalid Wakacje filter group");
    if (group["type"] !== "providerList") continue;
    if (!Array.isArray(group["data"])) throw new TypeError("Invalid Wakacje provider group");
    for (const item of group["data"]) {
      if (!isRecord(item) || !isRecord(item["attributes"])) {
        throw new TypeError("Invalid Wakacje travel provider");
      }
      const id = item["value"];
      const label = item["attributes"]["label"];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0
        || typeof label !== "string" || label.trim().length === 0) {
        throw new TypeError("Invalid Wakacje travel provider");
      }
      providers.set(id, { id, label: label.trim() });
    }
  }
  if (providers.size === 0) throw new TypeError("Empty Wakacje providers catalog");
  return [...providers.values()];
}

export class WakacjeClient {
  private readonly http: HttpClient;
  private readonly headers: Headers;

  constructor(options: WakacjeClientOptions, http?: HttpClient) {
    if (!isHeaderValue(options.authorization)) {
      throw new TypeError("Wakacje authorization must be a nonempty, header-safe ASCII value");
    }
    if (!isHeaderValue(options.deviceId)) {
      throw new TypeError("Wakacje deviceId must be a nonempty, header-safe ASCII value");
    }

    this.headers = new Headers({
      Authorization: options.authorization,
      "X-Device-ID": options.deviceId,
      Device: "mobile",
      Environment: "mobile app",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    this.http = http ?? new HttpClient({
      baseUrl: "https://thor.wakacje.pl/api/v1/wak-logic/",
      timeout: 30_000,
      ...(options.cookieJar === undefined ? {} : { cookieJar: options.cookieJar }),
    });
  }

  async listOffers({
    adultCount = 2,
    childCount = 0,
    imageLimit = 8,
    limit = 5,
    promotionList = [1],
    cateringList,
    destinationCountry,
    transportType,
    offerType,
    providerList,
    order,
    cursor,
  }: OfferListingOptions = {}, signal?: AbortSignal): Promise<HttpResponse<OfferListing>> {
    requireInteger(adultCount, 1, "adultCount");
    requireInteger(childCount, 0, "childCount");
    requireInteger(imageLimit, 0, "imageLimit");
    requireInteger(limit, 1, "limit");
    requireIdentifiers(promotionList, "promotionList");
    if (cateringList !== undefined) requireIdentifiers(cateringList, "cateringList");
    if (destinationCountry !== undefined) requireIdentifiers(destinationCountry, "destinationCountry");
    if (transportType !== undefined) requireIdentifiers(transportType, "transportType");
    if (offerType !== undefined) requireIdentifiers(offerType, "offerType");
    if (providerList !== undefined) requireIdentifiers(providerList, "providerList");
    if (order !== undefined && order !== 1 && order !== 11 && order !== 13) {
      throw new RangeError("order must be 1, 11, or 13 when supplied");
    }
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
      throw new TypeError("cursor must be a nonempty string when provided");
    }

    const response = await this.http.get<unknown>("search/listing", {
      ...(signal === undefined ? {} : { signal }),
      headers: this.headers,
      query: {
        adultCount,
        childCount,
        imageLimit,
        limit,
        promotionList: JSON.stringify(promotionList),
        ...(cateringList === undefined ? {} : { cateringList: JSON.stringify(cateringList) }),
        ...(destinationCountry === undefined ? {} : { destinationCountry: JSON.stringify(destinationCountry) }),
        ...(transportType === undefined ? {} : { transportType: JSON.stringify(transportType) }),
        ...(offerType === undefined ? {} : { offerType: JSON.stringify(offerType) }),
        ...(providerList === undefined ? {} : { providerList: JSON.stringify(providerList) }),
        ...(order === undefined ? {} : { order }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    let payload: unknown = response.data;
    // A terminal page uses data:null/count:0 while retaining the query's positive total.
    if (typeof payload === "object" && payload !== null && "data" in payload && payload.data === null
      && "meta" in payload && typeof payload.meta === "object" && payload.meta !== null
      && "count" in payload.meta && payload.meta.count === 0
      && "total" in payload.meta
      && "cursor" in payload.meta && payload.meta.cursor === "") {
      payload = { ...payload, data: [] };
    }
    if (!isOfferListing(payload)) {
      throw new TypeError("Invalid Wakacje offer listing response: expected an object with a data array");
    }
    return { ...response, data: payload };
  }

  getFilters(signal?: AbortSignal): Promise<HttpResponse<unknown>> {
    return this.http.get<unknown>("search/filters", {
      ...(signal === undefined ? {} : { signal }),
      headers: this.headers,
      query: { offerTypeList: "[]" },
    });
  }

  async getProviders(signal?: AbortSignal): Promise<HttpResponse<readonly TravelProvider[]>> {
    const response = await this.getFilters(signal);
    return { ...response, data: parseProviders(response.data) };
  }

  async getDestinations(signal?: AbortSignal): Promise<HttpResponse<readonly DestinationCountry[]>> {
    const response = await this.http.get<unknown>("search/destinations", {
      ...(signal === undefined ? {} : { signal }),
      headers: this.headers,
    });
    return { ...response, data: parseDestinations(response.data) };
  }
}

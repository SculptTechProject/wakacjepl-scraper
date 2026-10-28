export type ScrapeProfile = "all" | "last-minute" | "all-inclusive";
export type RunStatus = "running" | "completed" | "limited" | "failed";

export interface NormalizedOffer {
  readonly snapshotKey: string;
  readonly comparisonKey: string;
  readonly sourceId: number;
  readonly hotelId: number;
  readonly name: string;
  readonly country: string;
  /** Empty when the source does not provide an ISO country code. */
  readonly countryCode: string;
  readonly region: string;
  readonly departureId: number;
  readonly departure: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly nights: number;
  readonly cateringId: number;
  readonly catering: string;
  readonly providerCode: string;
  readonly provider: string;
  readonly roomId: string | null;
  readonly stars: number | null;
  readonly rating: number | null;
  readonly priceMinor: number;
  readonly currency: string;
  readonly priceType: "total";
  readonly adults: number;
  readonly children: number;
  readonly sourceHash: string;
}

export interface OfferObservation {
  readonly offer: NormalizedOffer;
  readonly observedAt: string;
  readonly sourceUrl: string;
  readonly rawJson: string;
}

export interface StoredOffer extends OfferObservation {
  readonly id: number;
  readonly runId: string;
  readonly profile: ScrapeProfile;
}

export interface RunSummary {
  readonly status: Exclude<RunStatus, "running">;
  readonly pages: number;
  readonly received: number;
  readonly inserted: number;
  readonly rejected: number;
  readonly finishedAt: string;
  readonly errorKind?: string;
  /** API total preserved by the collector; null when unknown. */
  readonly reportedTotal?: number | null;
  readonly stopReason?: string;
}

export interface RepositoryStats {
  readonly runs: number;
  readonly observations: number;
  readonly comparisonGroups: number;
  readonly rejected: number;
}

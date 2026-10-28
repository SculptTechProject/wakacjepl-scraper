-- SQLite / DataGrip. Each statement is read-only and can run independently.

-- Stored observations differ from hotels, source IDs, and comparison groups.
SELECT COUNT(*) AS observations,
       COUNT(DISTINCT comparison_key) AS comparison_groups,
       COUNT(DISTINCT source_id) AS source_ids,
       COUNT(DISTINCT hotel_id) AS hotels,
       MIN(observed_at) AS first_observed_at,
       MAX(observed_at) AS last_observed_at,
       (SELECT COUNT(*) FROM scrape_runs) AS runs,
       (SELECT COUNT(*) FROM rejected_offers WHERE resolved_at IS NULL) AS unresolved_records
FROM offer_observations;

-- Coverage audit. Stored rows also include subsequent quarantine recovery.
WITH stored AS (
    SELECT run_id,
           COUNT(*) AS stored_observations,
           COUNT(DISTINCT source_id) AS stored_source_ids
    FROM offer_observations
    GROUP BY run_id
)
SELECT r.id,
       r.profile,
       json_extract(r.query_json, '$.destinationCountry') AS requested_country,
       json_extract(r.query_json, '$.transportType') AS requested_transport,
       json_extract(r.query_json, '$.providerList') AS requested_provider,
       r.started_at,
       r.finished_at,
       r.status,
       r.stop_reason,
       r.reported_total,
       r.received,
       r.inserted AS ingestion_inserted,
       COALESCE(s.stored_observations, 0) AS stored_observations,
       COALESCE(s.stored_source_ids, 0) AS stored_source_ids,
       r.rejected AS ingestion_rejected,
       r.error_kind
FROM scrape_runs r
LEFT JOIN stored s ON s.run_id = r.id
ORDER BY r.started_at DESC, r.id
LIMIT 100;

-- Latest All Inclusive flight variants. Prices remain historical observations.
WITH latest AS (
    SELECT o.*,
           ROW_NUMBER() OVER (
               PARTITION BY comparison_key
               ORDER BY observed_at DESC, id DESC
           ) AS recency
    FROM offer_observations o
)
SELECT name,
       country,
       region,
       departure,
       start_date,
       nights,
       catering,
       provider,
       stars,
       rating,
       ROUND(price_minor / 100.0, 2) AS total_pln,
       ROUND(price_minor / (100.0 * adults * nights), 2) AS pln_per_person_night,
       observed_at
FROM latest
WHERE recency = 1
  AND adults = 2
  AND children = 0
  AND currency = 'PLN'
  AND price_type = 'total'
  AND price_minor > 0
  AND nights >= 1
  AND start_date >= date('now')
  AND catering_id = 1
  AND json_extract(raw_json, '$.transport.id') = 1
  AND stars >= 4
  AND rating >= 8
ORDER BY price_minor, rating DESC, id
LIMIT 50;

-- Observed source destinations and transport modes, independent of query filters.
WITH latest AS (
    SELECT o.*,
           ROW_NUMBER() OVER (
               PARTITION BY comparison_key
               ORDER BY observed_at DESC, id DESC
           ) AS recency
    FROM offer_observations o
)
SELECT country,
       country_code,
       json_extract(raw_json, '$.transport.id') AS transport_id,
       json_extract(raw_json, '$.transport.unifiedName') AS transport,
       COUNT(*) AS comparison_groups,
       COUNT(DISTINCT hotel_id) AS hotels
FROM latest
WHERE recency = 1
GROUP BY country, country_code, transport_id, transport
ORDER BY comparison_groups DESC, country;

-- A price trail for the comparison group with the most saved observations.
-- A missing room ID means this does not establish an identical package over time.
WITH selected AS (
    SELECT comparison_key
    FROM offer_observations
    GROUP BY comparison_key
    ORDER BY COUNT(*) DESC, comparison_key
    LIMIT 1
)
SELECT o.observed_at,
       o.name,
       o.departure,
       o.start_date,
       o.nights,
       o.catering,
       o.provider,
       o.room_id,
       o.price_minor,
       o.currency,
       r.profile,
       r.status
FROM offer_observations o
JOIN selected s ON s.comparison_key = o.comparison_key
JOIN scrape_runs r ON r.id = o.run_id
ORDER BY o.observed_at, o.id;

-- Quarantine remains auditable after normalization repairs.
SELECT reason,
       CASE WHEN resolved_at IS NULL THEN 'unresolved' ELSE 'resolved' END AS resolution,
       COUNT(*) AS records,
       MIN(observed_at) AS first_observed_at,
       MAX(observed_at) AS last_observed_at
FROM rejected_offers
GROUP BY reason, resolution
ORDER BY records DESC, reason;

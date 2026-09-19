-- Apply to a Tiger Data / TimescaleDB database before enabling TIGER_DATABASE_URL.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS investigation_events (
  occurred_at timestamptz NOT NULL,
  event_id uuid NOT NULL,
  pseudonymous_case_id text NOT NULL CHECK (pseudonymous_case_id ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type IN ('ingested','investigated','simulated','released','provider_failure','human_override','redacted')),
  duration_ms double precision NOT NULL CHECK (duration_ms >= 0),
  status text NOT NULL CHECK (status IN ('success','blocked','unavailable')),
  PRIMARY KEY (occurred_at, event_id)
);
SELECT create_hypertable('investigation_events', by_range('occurred_at'), if_not_exists => TRUE);
CREATE MATERIALIZED VIEW IF NOT EXISTS investigation_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', occurred_at) AS hour,
  count(*) AS throughput,
  avg(duration_ms) AS average_duration_ms,
  count(*) FILTER (WHERE status <> 'success') AS failures,
  count(*) FILTER (WHERE status <> 'success')::double precision / count(*) AS failure_rate,
  count(*) FILTER (WHERE event_type = 'released') AS releases,
  count(*) FILTER (WHERE event_type = 'redacted') AS redaction_count,
  count(*) FILTER (WHERE event_type = 'human_override') AS human_overrides,
  count(*) FILTER (WHERE event_type = 'human_override')::double precision / count(*) AS human_override_rate
FROM investigation_events GROUP BY hour WITH NO DATA;
SELECT add_continuous_aggregate_policy('investigation_hourly',
  start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
-- Exact median is intentionally a separate ordinary view for version portability.
CREATE OR REPLACE VIEW investigation_hourly_median AS
SELECT date_trunc('hour', occurred_at) AS hour,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_duration_ms
FROM investigation_events GROUP BY 1;

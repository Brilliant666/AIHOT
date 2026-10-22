-- Deployment-wide request admission counts live attempts across every service in the last day.
-- Keep the bounded time scan independent of the service-prefixed per-provider budget index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS receipt_attempts_live_time_idx
  ON receipt_attempts (started_at) WHERE origin = 'live';

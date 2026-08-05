BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS incidents (
  region_id text NOT NULL,
  virtual_shard smallint NOT NULL CHECK (virtual_shard BETWEEN 0 AND 255),
  id uuid NOT NULL,
  authority text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('REPORTED','TRIAGED','ALLOCATING','ASSIGNED','ACTIVE','RESOLVED','CANCELLED')),
  priority text NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  priority_score numeric NOT NULL,
  location geography(Point,4326) NOT NULL,
  payload jsonb NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(region_id, virtual_shard, id),
  UNIQUE(region_id, virtual_shard, authority, idempotency_key)
) PARTITION BY HASH (virtual_shard);

CREATE TABLE IF NOT EXISTS resources (
  region_id text NOT NULL,
  virtual_shard smallint NOT NULL CHECK (virtual_shard BETWEEN 0 AND 255),
  id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('AVAILABLE','HELD','DISPATCHED','EN_ROUTE','ON_SCENE','TRANSPORTING','AT_FACILITY','RELEASED','OUT_OF_SERVICE','UNKNOWN')),
  location geography(Point,4326) NOT NULL,
  spatial_cell text NOT NULL,
  capabilities text[] NOT NULL,
  capacity integer NOT NULL CHECK (capacity >= 0),
  healthy boolean NOT NULL,
  maintenance boolean NOT NULL,
  source_sequence bigint NOT NULL CHECK (source_sequence >= 0),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  fencing_epoch bigint NOT NULL DEFAULT 0 CHECK (fencing_epoch >= 0),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(region_id, virtual_shard, id)
) PARTITION BY HASH (virtual_shard);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS incidents_p%s PARTITION OF incidents FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    EXECUTE format('CREATE TABLE IF NOT EXISTS resources_p%s PARTITION OF resources FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS incidents_status_priority_idx ON incidents(region_id,status,priority,accepted_at);
CREATE INDEX IF NOT EXISTS incidents_location_idx ON incidents USING gist(location);
CREATE INDEX IF NOT EXISTS resources_search_idx ON resources(region_id,status,spatial_cell);
CREATE INDEX IF NOT EXISTS resources_location_idx ON resources USING gist(location);
CREATE INDEX IF NOT EXISTS resources_capabilities_idx ON resources USING gin(capabilities);

CREATE TABLE IF NOT EXISTS assignments (
  id uuid PRIMARY KEY,
  incident_region_id text NOT NULL,
  incident_virtual_shard smallint NOT NULL,
  incident_id uuid NOT NULL,
  resource_region_id text NOT NULL,
  resource_virtual_shard smallint NOT NULL,
  resource_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('HELD','DISPATCHED','ACCEPTED','REJECTED','EN_ROUTE','ARRIVED','NEED_ASSISTANCE','COMPLETED','CANCELLED')),
  resource_epoch bigint NOT NULL,
  shard_epoch bigint NOT NULL,
  resource_version bigint NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(incident_region_id,incident_virtual_shard,incident_id)
    REFERENCES incidents(region_id,virtual_shard,id),
  FOREIGN KEY(resource_region_id,resource_virtual_shard,resource_id)
    REFERENCES resources(region_id,virtual_shard,id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment_per_resource
  ON assignments(resource_region_id,resource_virtual_shard,resource_id)
  WHERE status IN ('HELD','DISPATCHED','ACCEPTED','EN_ROUTE','ARRIVED','NEED_ASSISTANCE');

CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY,
  incident_region_id text NOT NULL,
  incident_virtual_shard smallint NOT NULL,
  incident_id uuid NOT NULL,
  mode text NOT NULL,
  policy_version text NOT NULL,
  map_version text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  priority smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  deliver_by timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox(priority,created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS processed_events (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(consumer,event_id)
);

CREATE TABLE IF NOT EXISTS notification_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL,
  recipient_id text NOT NULL,
  channel text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  priority text NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED','SENDING','ACCEPTED','DELIVERED','ACKNOWLEDGED','FAILED','EXPIRED','CANCELLED')),
  provider text,
  expires_at timestamptz NOT NULL,
  next_retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(notification_id,recipient_id,channel,version)
);
CREATE INDEX IF NOT EXISTS notification_jobs_ready_idx
  ON notification_jobs(priority,next_retry_at,updated_at)
  WHERE status IN ('QUEUED','FAILED');

CREATE TABLE IF NOT EXISTS notification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_job_id uuid NOT NULL REFERENCES notification_jobs(job_id),
  recipient_id text NOT NULL,
  channel text NOT NULL,
  version bigint NOT NULL,
  provider text NOT NULL,
  outcome text NOT NULL,
  provider_message_id text,
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  next_retry_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_attempts_message_idx
  ON notification_attempts(provider,provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_status_events (
  event_id text PRIMARY KEY,
  provider text NOT NULL,
  provider_message_id text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS integration_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  region_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS integration_events_region_time_idx ON integration_events(region_id,received_at DESC);

CREATE TABLE IF NOT EXISTS shard_directory (
  region_id text NOT NULL,
  virtual_shard smallint NOT NULL CHECK (virtual_shard BETWEEN 0 AND 255),
  physical_owner text NOT NULL,
  standby_owner text NOT NULL,
  ownership_epoch bigint NOT NULL CHECK (ownership_epoch > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE','MOVING','READ_ONLY','FENCED')),
  lease_expires_at timestamptz,
  takeover_evidence jsonb,
  replication_watermark pg_lsn,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(region_id,virtual_shard)
);

CREATE TABLE IF NOT EXISTS audit_log (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  actor text NOT NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  payload jsonb NOT NULL,
  previous_hash text NOT NULL,
  record_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION claim_resource(
  p_region text, p_shard smallint, p_resource uuid, p_expected_version bigint
) RETURNS TABLE(new_version bigint,new_epoch bigint) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  UPDATE resources
     SET status='HELD', aggregate_version=aggregate_version+1,
         fencing_epoch=fencing_epoch+1, updated_at=clock_timestamp()
   WHERE region_id=p_region AND virtual_shard=p_shard AND id=p_resource
     AND aggregate_version=p_expected_version AND status='AVAILABLE'
  RETURNING aggregate_version,fencing_epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_CONFLICT' USING ERRCODE='40001';
  END IF;
END;
$$;

COMMIT;

-- Run read-only after migrations, restores, failovers, and before promotion.
-- Any returned row is a release-blocking safety violation.

SELECT resource_region_id, resource_virtual_shard, resource_id, count(*) AS active_assignment_count
FROM assignments
WHERE status IN ('HELD','DISPATCHED','ACCEPTED','EN_ROUTE','ARRIVED','NEED_ASSISTANCE')
GROUP BY resource_region_id, resource_virtual_shard, resource_id
HAVING count(*) > 1;

SELECT region_id, virtual_shard, count(*) AS active_owner_count
FROM shard_directory
WHERE state = 'ACTIVE'
GROUP BY region_id, virtual_shard
HAVING count(*) > 1;

SELECT notification_id, recipient_id, channel, version, status, expires_at
FROM notification_jobs
WHERE status NOT IN ('EXPIRED','CANCELLED','ACKNOWLEDGED')
  AND expires_at <= clock_timestamp();

SELECT a.id, a.resource_id, a.resource_epoch, r.fencing_epoch
FROM assignments a
JOIN resources r
  ON r.region_id = a.resource_region_id
 AND r.virtual_shard = a.resource_virtual_shard
 AND r.id = a.resource_id
WHERE a.status IN ('HELD','DISPATCHED','ACCEPTED','EN_ROUTE','ARRIVED','NEED_ASSISTANCE')
  AND a.resource_epoch <> r.fencing_epoch;

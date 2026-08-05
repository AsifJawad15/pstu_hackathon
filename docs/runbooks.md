# Operational runbooks

## Database primary failure

1. Stop writes through the former primary and prove fencing.
2. Promote only the most advanced synchronous standby.
3. Increment the ownership epoch before reopening reservations.
4. Reconcile transactional outbox rows and active assignments.
5. Reject commands carrying the former epoch and record the incident timeline.

## Broker unavailable or lagging

1. Preserve PostgreSQL reservation and outbox processing.
2. Pause analytics and bulk-warning topics before P0/P1 work.
3. Restore quorum without deleting backlog.
4. Drain outbox with retry budgets and consumer deduplication.
5. Verify oldest-event age and projection hashes before clearing the incident.

## Optimizer or routing unavailable

Use the deterministic allocator. Routing falls back to the last validated local graph and conservative geometric ETA. Mark confidence visibly, freeze nonessential reassignment, and require an operator when policy thresholds are crossed.

## Regional partition or loss

An isolated owning region continues local work but suspends cross-region transfers. A paired region must not take ownership on heartbeat loss alone. Require positive fencing or proved lease expiry, increment the shard epoch, replay to the replication watermark, mark newer resources `UNKNOWN`, and reconcile them with devices or the EOC.

## Notification provider failure

Open its circuit, retain durable notification jobs, start the configured secondary provider/channel, continue callback ingestion, deduplicate late statuses, and escalate unacknowledged P0 dispatch through EOC/radio/voice.

## Data corruption

Stop propagation, retain evidence, identify the last trusted watermark, restore into isolated infrastructure, validate hashes and constraints, replay trusted events, and reopen writes only after two-person approval.

## Total digital failure

Use local EOC radio, satellite, telephone trees and sequence-numbered paper/manual dispatch. Do not automate reconciliation later: compare manual assignments, device state and platform epochs under operator supervision.


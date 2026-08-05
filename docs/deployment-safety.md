# Deployment and rollback safety

Production promotion uses immutable, signed image digests and an expand-migrate-contract schema sequence. Emergency-path changes are never coupled to destructive schema changes in the same release.

## Promotion sequence

1. Run contract compatibility, deterministic replay, reservation stress, notification failover, and PostgreSQL invariant verification.
2. Deploy to a shadow environment and compare decisions without issuing commands.
3. Canary one regional cell at 1%, then 10%, then 50% traffic while the previous version remains warm.
4. Promote only when critical latency, queue age, fallback rate, stale-epoch rejection, error rate, and decision-difference thresholds pass.
5. Hold the previous image, policy bundle, map snapshot, and compatible schema until the rollback window closes.

Automated rollback triggers on any safety-invariant failure, ownership conflict, contract incompatibility, P0 queue-age breach, unexplained decision divergence, or critical error-budget burn. Rollback changes application ownership only after fencing the new controller. Database rollback is normally forward repair: contract migrations happen only after all older binaries are retired and the rollback window has closed.

## Release freeze

Routine releases stop during declared major emergencies. A break-glass fix requires two-person approval, a linked incident record, a bounded regional canary, and an after-action review.

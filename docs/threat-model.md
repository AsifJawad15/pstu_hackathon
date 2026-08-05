# Threat model

## Highest-risk assets

- Authority to issue dispatch and public-warning commands.
- Exclusive resource ownership and fencing epochs.
- Patient, victim, responder and infrastructure location data.
- Policy, map and optimization inputs.
- Signing, recovery and backup credentials.
- Immutable decision and override evidence.

## Principal threats and controls

| Threat | Required controls |
|---|---|
| Forged incident or telemetry | mTLS/device identity, signatures, authority checks, sequence and time windows |
| Replayed command | Command ID, deadline, monotonic sequence and resource/shard epochs |
| Double assignment | Conditional transaction, active-resource uniqueness and device fencing |
| Split-brain region | Quorum lease, positive fencing and uncertain-resource quarantine |
| P0 starvation | Dedicated queue, CPU, connection and bandwidth capacity |
| Compromised provider | Signed command content, provider isolation and parallel independent channel |
| Privileged misuse | Phishing-resistant MFA, ABAC, dual-control warning authority and immutable audit |
| Sensitive location disclosure | Least privilege, precision reduction, field protection and no payload logging |
| Supply-chain compromise | Locked dependencies, SBOM, signed provenance, scanning and digest-pinned production images |
| Backup destruction | Separate credentials, immutable object lock, offline recovery keys and restore drills |

Public warnings and real dispatch require an authority-approved policy bundle. The development bearer-token adapter is not a production identity mechanism.


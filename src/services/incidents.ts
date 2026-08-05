import { randomUUID } from "node:crypto";
import { calculatePriority, DEFAULT_POLICY, validateIncident, type PolicyBundle } from "../domain/policy.ts";
import type { Incident, IncidentInput } from "../domain/types.ts";
import type { OperationalDatabase } from "../platform/database.ts";
import type { EncryptedEdgeSpool } from "../platform/edgeSpool.ts";
import type { AdmissionController } from "../platform/priorityQueue.ts";
import { virtualShard } from "../platform/sharding.ts";

export type IncidentReceipt = {
  incident: Incident;
  status: "ACCEPTED" | "DUPLICATE" | "RECEIVED_DEGRADED";
};

export class IncidentService {
  readonly #database: OperationalDatabase;
  readonly #admission: AdmissionController;
  readonly #policy: PolicyBundle;
  readonly #spool: EncryptedEdgeSpool | undefined;

  constructor(
    database: OperationalDatabase,
    admission: AdmissionController,
    policy: PolicyBundle = DEFAULT_POLICY,
    spool?: EncryptedEdgeSpool,
  ) {
    this.#database = database;
    this.#admission = admission;
    this.#policy = policy;
    this.#spool = spool;
  }

  report(input: IncidentInput): IncidentReceipt {
    validateIncident(input);
    const priority = calculatePriority(input, this.#policy);
    const release = this.#admission.enter(priority.priority);
    const incidentId = input.incidentId ?? randomUUID();
    const incident: Incident = {
      ...input, incidentId, priority: priority.priority, priorityScore: priority.score,
      status: "REPORTED", version: 1, virtualShard: virtualShard(input.location.regionId, incidentId),
      acceptedAt: new Date().toISOString(),
    };
    try {
      try {
        const result = this.#database.acceptIncident(incident);
        this.#database.appendAudit(input.metadata.authority, result.duplicate ? "INCIDENT_DUPLICATE" : "INCIDENT_ACCEPTED", incidentId, {
          priority: incident.priority, traceId: input.metadata.traceId,
        });
        return { incident: result.incident, status: result.duplicate ? "DUPLICATE" : "ACCEPTED" };
      } catch (error) {
        if (!this.#spool) throw error;
        this.#spool.append({ kind: "INCIDENT", incident });
        return { incident, status: "RECEIVED_DEGRADED" };
      }
    } finally {
      release();
    }
  }

  update(incidentId: string, expectedVersion: number, patch: Partial<Pick<IncidentInput,
    "severity" | "affectedPeople" | "timeToHarmMinutes" | "requiredCapabilities" | "requiredCapacity" |
    "hazards" | "vulnerableGroups" | "environmentalEscalation" | "confidence" | "responseDeadline">>): Incident {
    const current = this.#database.getIncident(incidentId);
    if (!current) throw Object.assign(new Error("Incident not found"), { code: "INCIDENT_NOT_FOUND", status: 404 });
    if (current.version !== expectedVersion) throw Object.assign(new Error("Incident version changed"), { code: "INCIDENT_VERSION_CONFLICT", status: 409 });
    const candidate = { ...current, ...patch, metadata: { ...current.metadata, aggregateVersion: expectedVersion + 1 } };
    validateIncident(candidate);
    const priority = calculatePriority(candidate, this.#policy);
    const next: Incident = { ...candidate, priority: priority.priority, priorityScore: priority.score, version: expectedVersion + 1 };
    const result = this.#database.replaceIncident(current, next);
    this.#database.appendAudit(current.metadata.authority, "INCIDENT_UPDATED", incidentId, { expectedVersion, patch });
    return result;
  }

  cancel(incidentId: string, expectedVersion: number, actor: string, reason: string): Incident {
    const next = this.#database.transitionIncident(incidentId, expectedVersion, "CANCELLED");
    this.#database.appendAudit(actor, "INCIDENT_CANCELLED", incidentId, { reason, expectedVersion });
    return next;
  }
}

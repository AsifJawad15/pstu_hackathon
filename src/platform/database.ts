import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../domain/errors.ts";
import { assertAssignmentTransition, assertIncidentTransition, assertResourceTransition } from "../domain/stateMachines.ts";
import type {
  Assignment, AssignmentStatus, DecisionExplanation, Incident, IncidentStatus, NotificationStatus,
  PublicWarningInput, Resource, ResourceStatus, ResourceTelemetryInput,
} from "../domain/types.ts";
import { spatialCell } from "./spatial.ts";
import { virtualShard } from "./sharding.ts";

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;

function json<T>(value: SqlValue): T {
  return JSON.parse(String(value)) as T;
}

function bool(value: SqlValue): boolean { return Number(value) === 1; }

export class OperationalDatabase {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void { this.db.close(); }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        region_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        authority TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        priority TEXT NOT NULL,
        priority_score REAL NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        virtual_shard INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        UNIQUE(authority, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS incidents_region_status_idx ON incidents(region_id, status, priority);

      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        region_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        spatial_cell TEXT NOT NULL,
        status TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        version INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        virtual_shard INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resources_lookup_idx ON resources(region_id, status, spatial_cell);

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES incidents(id),
        resource_id TEXT NOT NULL REFERENCES resources(id),
        status TEXT NOT NULL,
        resource_epoch INTEGER NOT NULL,
        shard_epoch INTEGER NOT NULL,
        resource_version INTEGER NOT NULL,
        command_id TEXT NOT NULL UNIQUE,
        facility_id TEXT,
        facility_capability TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS assignments_one_active_resource_idx
        ON assignments(resource_id)
        WHERE status IN ('HELD','DISPATCHED','ACCEPTED','EN_ROUTE','ARRIVED','NEED_ASSISTANCE');
      CREATE INDEX IF NOT EXISTS assignments_incident_idx ON assignments(incident_id, status);

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES incidents(id),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox(published_at, created_at);

      CREATE TABLE IF NOT EXISTS processed_events (
        consumer TEXT NOT NULL,
        event_id TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY(consumer, event_id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        dedup_key TEXT PRIMARY KEY,
        notification_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        provider TEXT,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS warnings (
        id TEXT PRIMARY KEY,
        authority TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS facility_capacity (
        facility_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        region_id TEXT NOT NULL,
        available INTEGER NOT NULL,
        reserved INTEGER NOT NULL,
        source_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(facility_id, capability)
      );
      CREATE INDEX IF NOT EXISTS facility_capacity_region_idx ON facility_capacity(region_id, capability);

      CREATE TABLE IF NOT EXISTS facility_locations (
        facility_id TEXT PRIMARY KEY,
        region_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        name TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS environment_state (
        event_id TEXT PRIMARY KEY,
        region_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        map_version TEXT NOT NULL,
        effective_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shard_directory (
        region_id TEXT NOT NULL,
        virtual_shard INTEGER NOT NULL,
        physical_owner TEXT NOT NULL,
        standby_owner TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY(region_id, virtual_shard)
      );
    `);
  }

  acceptIncident(incident: Incident): { incident: Incident; duplicate: boolean } {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO incidents
        (id, region_id, idempotency_key, authority, payload_json, priority, priority_score, status, version, virtual_shard, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = insert.run(
        incident.incidentId, incident.location.regionId, incident.metadata.idempotencyKey, incident.metadata.authority,
        JSON.stringify(incident), incident.priority, incident.priorityScore, incident.status, incident.version,
        incident.virtualShard, incident.acceptedAt,
      );
      if (Number(result.changes) === 1) {
        this.addOutbox("INCIDENT", incident.incidentId, "IncidentAccepted", incident);
        this.db.exec("COMMIT");
        return { incident, duplicate: false };
      }
      const row = this.db.prepare("SELECT payload_json FROM incidents WHERE authority=? AND idempotency_key=?")
        .get(incident.metadata.authority, incident.metadata.idempotencyKey) as Row | undefined;
      if (!row) throw new AppError("INCIDENT_CONFLICT", "Incident could not be accepted", 409);
      this.db.exec("COMMIT");
      return { incident: json<Incident>(row.payload_json!), duplicate: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getIncident(id: string): Incident | undefined {
    const row = this.db.prepare("SELECT payload_json, status, version FROM incidents WHERE id=?").get(id) as Row | undefined;
    if (!row) return undefined;
    return { ...json<Incident>(row.payload_json!), status: String(row.status) as IncidentStatus, version: Number(row.version) };
  }

  transitionIncident(id: string, expectedVersion: number, status: IncidentStatus): Incident {
    const current = this.getIncident(id);
    if (!current) throw new AppError("INCIDENT_NOT_FOUND", "Incident not found", 404);
    assertIncidentTransition(current.status, status);
    const next = { ...current, status, version: current.version + 1 };
    const result = this.db.prepare("UPDATE incidents SET status=?, version=?, payload_json=? WHERE id=? AND version=?")
      .run(status, next.version, JSON.stringify(next), id, expectedVersion);
    if (Number(result.changes) !== 1) throw new AppError("INCIDENT_VERSION_CONFLICT", "Incident version changed", 409);
    this.addOutbox("INCIDENT", id, "IncidentStateChanged", next);
    return next;
  }

  replaceIncident(current: Incident, next: Incident): Incident {
    if (current.incidentId !== next.incidentId) throw new AppError("INCIDENT_ID_IMMUTABLE", "Incident ID cannot change", 422);
    const result = this.db.prepare("UPDATE incidents SET payload_json=?,priority=?,priority_score=?,version=? WHERE id=? AND version=?")
      .run(JSON.stringify(next), next.priority, next.priorityScore, next.version, next.incidentId, current.version);
    if (Number(result.changes) !== 1) throw new AppError("INCIDENT_VERSION_CONFLICT", "Incident version changed", 409);
    this.addOutbox("INCIDENT", next.incidentId, "IncidentUpdated", next);
    return next;
  }

  upsertResource(input: ResourceTelemetryInput): { resource: Resource; applied: boolean } {
    const existing = this.getResource(input.resourceId);
    if (existing && input.sourceSequence <= existing.sourceSequence) return { resource: existing, applied: false };
    if (existing) assertResourceTransition(existing.status, input.status);
    const now = new Date().toISOString();
    const resource: Resource = {
      ...input,
      version: (existing?.version ?? 0) + 1,
      epoch: existing?.epoch ?? 0,
      virtualShard: virtualShard(input.location.regionId, input.resourceId),
      updatedAt: now,
      spatialCell: spatialCell(input.location),
    };
    this.db.prepare(`
      INSERT INTO resources (id,region_id,payload_json,spatial_cell,status,source_sequence,version,epoch,virtual_shard,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET region_id=excluded.region_id,payload_json=excluded.payload_json,
        spatial_cell=excluded.spatial_cell,status=excluded.status,source_sequence=excluded.source_sequence,
        version=excluded.version,epoch=excluded.epoch,virtual_shard=excluded.virtual_shard,updated_at=excluded.updated_at
      WHERE excluded.source_sequence > resources.source_sequence
    `).run(input.resourceId, input.location.regionId, JSON.stringify(resource), resource.spatialCell, resource.status,
      resource.sourceSequence, resource.version, resource.epoch, resource.virtualShard, now);
    this.addOutbox("RESOURCE", resource.resourceId, "ResourceStateUpdated", resource);
    return { resource, applied: true };
  }

  getResource(id: string): Resource | undefined {
    const row = this.db.prepare("SELECT payload_json,status,source_sequence,version,epoch,updated_at,spatial_cell FROM resources WHERE id=?")
      .get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      ...json<Resource>(row.payload_json!), status: String(row.status) as ResourceStatus,
      sourceSequence: Number(row.source_sequence), version: Number(row.version), epoch: Number(row.epoch),
      updatedAt: String(row.updated_at), spatialCell: String(row.spatial_cell),
    };
  }

  listResources(regionId: string): Resource[] {
    const rows = this.db.prepare("SELECT id FROM resources WHERE region_id=?").all(regionId) as Row[];
    return rows.map((row) => this.getResource(String(row.id))).filter((value): value is Resource => Boolean(value));
  }

  storeDecision(decision: DecisionExplanation): void {
    this.db.prepare("INSERT INTO decisions(id,incident_id,payload_json,created_at) VALUES(?,?,?,?)")
      .run(decision.decisionId, decision.incidentId, JSON.stringify(decision), decision.generatedAt);
    this.addOutbox("DECISION", decision.decisionId, "DecisionCreated", decision);
  }

  getDecision(id: string): DecisionExplanation | undefined {
    const row = this.db.prepare("SELECT payload_json FROM decisions WHERE id=?").get(id) as Row | undefined;
    return row ? json<DecisionExplanation>(row.payload_json!) : undefined;
  }

  latestDecisionForIncident(incidentId: string): DecisionExplanation | undefined {
    const row = this.db.prepare("SELECT payload_json FROM decisions WHERE incident_id=? ORDER BY created_at DESC LIMIT 1")
      .get(incidentId) as Row | undefined;
    return row ? json<DecisionExplanation>(row.payload_json!) : undefined;
  }

  reserveResources(
    incidentId: string,
    requested: Array<{ resourceId: string; expectedVersion: number; facilityId?: string; facilityCapability?: string }>,
    shardEpoch: number,
  ): Assignment[] {
    if (requested.length === 0) throw new AppError("NO_RESOURCES_REQUESTED", "At least one resource is required");
    const ordered = [...requested].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const incident = this.getIncident(incidentId);
      if (!incident) throw new AppError("INCIDENT_NOT_FOUND", "Incident not found", 404);
      if (incident.status !== "ALLOCATING") {
        throw new AppError("INCIDENT_NOT_ALLOCATING", "Incident must be in ALLOCATING state before reservation", 409);
      }
      const now = new Date().toISOString();
      const assignments: Assignment[] = [];
      for (const request of ordered) {
        const current = this.getResource(request.resourceId);
        if (!current) throw new AppError("RESOURCE_NOT_FOUND", `Resource ${request.resourceId} not found`, 404);
        const nextEpoch = current.epoch + 1;
        const nextResource = { ...current, status: "HELD" as const, version: current.version + 1, epoch: nextEpoch, updatedAt: now };
        const held = this.db.prepare(`
          UPDATE resources SET status='HELD',version=version+1,epoch=epoch+1,updated_at=?,payload_json=?
          WHERE id=? AND version=? AND status='AVAILABLE'
        `).run(now, JSON.stringify(nextResource), request.resourceId, request.expectedVersion);
        if (Number(held.changes) !== 1) throw new AppError("RESOURCE_CONFLICT", `Resource ${request.resourceId} is no longer available`, 409);
        const assignment: Assignment = {
          assignmentId: randomUUID(), incidentId, resourceId: request.resourceId, status: "HELD",
          resourceEpoch: nextEpoch, shardEpoch, resourceVersion: current.version + 1,
          commandId: randomUUID(), createdAt: now, updatedAt: now,
          ...(request.facilityId ? { facilityId: request.facilityId } : {}),
          ...(request.facilityCapability ? { facilityCapability: request.facilityCapability } : {}),
        };
        this.db.prepare(`INSERT INTO assignments
          (id,incident_id,resource_id,status,resource_epoch,shard_epoch,resource_version,command_id,facility_id,facility_capability,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          assignment.assignmentId, assignment.incidentId, assignment.resourceId, assignment.status,
          assignment.resourceEpoch, assignment.shardEpoch, assignment.resourceVersion, assignment.commandId,
          assignment.facilityId ?? null, assignment.facilityCapability ?? null,
          assignment.createdAt, assignment.updatedAt,
        );
        assignments.push(assignment);
      }
      const nextIncident = { ...incident, status: "ASSIGNED" as const, version: incident.version + 1 };
      this.db.prepare("UPDATE incidents SET status='ASSIGNED',version=version+1,payload_json=? WHERE id=? AND version=?")
        .run(JSON.stringify(nextIncident), incidentId, incident.version);
      for (const assignment of assignments) this.addOutbox("ASSIGNMENT", assignment.assignmentId, "AssignmentHeld", assignment);
      this.db.exec("COMMIT");
      return assignments;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transitionAssignment(id: string, status: AssignmentStatus): Assignment {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const assignment = this.getAssignment(id);
      if (!assignment) throw new AppError("ASSIGNMENT_NOT_FOUND", "Assignment not found", 404);
      assertAssignmentTransition(assignment.status, status);
      const now = new Date().toISOString();
      const next = { ...assignment, status, updatedAt: now };
      this.db.prepare("UPDATE assignments SET status=?,updated_at=? WHERE id=? AND status=?")
        .run(status, now, id, assignment.status);
      const resource = this.getResource(assignment.resourceId);
      if (!resource) throw new AppError("RESOURCE_NOT_FOUND", "Assignment resource not found", 500);
      const mapped = resourceStatusForAssignment(status, resource.status);
      assertResourceTransition(resource.status, mapped);
      const nextResource = { ...resource, status: mapped, version: resource.version + 1, updatedAt: now };
      this.db.prepare("UPDATE resources SET status=?,version=version+1,updated_at=?,payload_json=? WHERE id=? AND version=?")
        .run(mapped, now, JSON.stringify(nextResource), resource.resourceId, resource.version);
      this.addOutbox("ASSIGNMENT", id, `Assignment${status}`, next);
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getAssignment(id: string): Assignment | undefined {
    const row = this.db.prepare("SELECT * FROM assignments WHERE id=?").get(id) as Row | undefined;
    return row ? rowToAssignment(row) : undefined;
  }

  assignmentsForIncident(incidentId: string): Assignment[] {
    return (this.db.prepare("SELECT * FROM assignments WHERE incident_id=? ORDER BY resource_id").all(incidentId) as Row[])
      .map(rowToAssignment);
  }

  addOutbox(aggregateType: string, aggregateId: string, eventType: string, payload: unknown): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO outbox(id,aggregate_type,aggregate_id,event_type,payload_json,created_at)
      VALUES(?,?,?,?,?,?)`).run(id, aggregateType, aggregateId, eventType, JSON.stringify(payload), new Date().toISOString());
    return id;
  }

  pendingOutbox(limit = 100): Array<{ id: string; eventType: string; payload: unknown }> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return (this.db.prepare(`SELECT id,event_type,payload_json FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT ${safeLimit}`)
      .all() as Row[]).map((row) => ({ id: String(row.id), eventType: String(row.event_type), payload: json(row.payload_json!) }));
  }

  markOutboxPublished(id: string): void {
    this.db.prepare("UPDATE outbox SET published_at=?,attempt_count=attempt_count+1,last_error=NULL WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  markOutboxFailed(id: string, error: string): void {
    this.db.prepare("UPDATE outbox SET attempt_count=attempt_count+1,last_error=? WHERE id=?").run(error.slice(0, 500), id);
  }

  processOnce(consumer: string, eventId: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO processed_events(consumer,event_id,processed_at) VALUES(?,?,?)")
      .run(consumer, eventId, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  upsertNotification(
    notificationId: string, recipientId: string, channel: string, version: number,
    status: NotificationStatus, expiresAt: string, provider?: string,
  ): { created: boolean; status: NotificationStatus } {
    const key = `${notificationId}:${recipientId}:${channel}:${version}`;
    const result = this.db.prepare(`INSERT OR IGNORE INTO notifications
      (dedup_key,notification_id,recipient_id,channel,version,status,provider,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(key, notificationId, recipientId, channel, version, status,
      provider ?? null, expiresAt, new Date().toISOString());
    const row = this.db.prepare("SELECT status FROM notifications WHERE dedup_key=?").get(key) as Row;
    return { created: Number(result.changes) === 1, status: String(row.status) as NotificationStatus };
  }

  setNotificationStatus(
    notificationId: string, recipientId: string, channel: string, version: number,
    status: NotificationStatus, provider?: string,
  ): void {
    const key = `${notificationId}:${recipientId}:${channel}:${version}`;
    this.db.prepare("UPDATE notifications SET status=?,provider=?,updated_at=? WHERE dedup_key=?")
      .run(status, provider ?? null, new Date().toISOString(), key);
  }

  claimNotification(notificationId: string, recipientId: string, channel: string, version: number): boolean {
    const key = `${notificationId}:${recipientId}:${channel}:${version}`;
    const result = this.db.prepare("UPDATE notifications SET status='SENDING',updated_at=? WHERE dedup_key=? AND status IN ('QUEUED','FAILED')")
      .run(new Date().toISOString(), key);
    return Number(result.changes) === 1;
  }

  updateFacilityCapacity(input: {
    facilityId: string; capability: string; regionId: string; available: number; reserved: number; sourceSequence: number;
  }): boolean {
    const result = this.db.prepare(`INSERT INTO facility_capacity
      (facility_id,capability,region_id,available,reserved,source_sequence,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(facility_id,capability) DO UPDATE SET region_id=excluded.region_id,available=excluded.available,
      reserved=excluded.reserved,source_sequence=excluded.source_sequence,updated_at=excluded.updated_at
      WHERE excluded.source_sequence > facility_capacity.source_sequence`).run(
      input.facilityId, input.capability, input.regionId, input.available, input.reserved, input.sourceSequence,
      new Date().toISOString(),
    );
    if (Number(result.changes) === 1) this.addOutbox("FACILITY", input.facilityId, "FacilityCapacityUpdated", input);
    return Number(result.changes) === 1;
  }

  addEnvironmentEvent(input: {
    eventId: string; regionId: string; eventType: string; payload: unknown; mapVersion: string; effectiveAt: string; expiresAt: string;
  }): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO environment_state
      (event_id,region_id,event_type,payload_json,map_version,effective_at,expires_at) VALUES(?,?,?,?,?,?,?)`).run(
      input.eventId, input.regionId, input.eventType, JSON.stringify(input.payload), input.mapVersion, input.effectiveAt, input.expiresAt,
    );
    if (Number(result.changes) === 1) this.addOutbox("ENVIRONMENT", input.eventId, "EnvironmentUpdated", input);
    return Number(result.changes) === 1;
  }

  createWarning(input: PublicWarningInput, warningId: string): void {
    this.db.prepare("INSERT INTO warnings(id,authority,payload_json,status,created_at) VALUES(?,?,?,?,?)")
      .run(warningId, input.authority, JSON.stringify({ ...input, warningId }), "QUEUED", new Date().toISOString());
    this.addOutbox("WARNING", warningId, "PublicWarningAuthorized", { ...input, warningId });
  }

  appendAudit(actor: string, action: string, targetId: string, payload: unknown): string {
    const previous = this.db.prepare("SELECT record_hash FROM audit_log ORDER BY sequence DESC LIMIT 1").get() as Row | undefined;
    const previousHash = previous ? String(previous.record_hash) : "GENESIS";
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const body = JSON.stringify({ eventId, actor, action, targetId, payload, previousHash, createdAt });
    const recordHash = sha256(body);
    this.db.prepare(`INSERT INTO audit_log(event_id,actor,action,target_id,payload_json,previous_hash,record_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(eventId, actor, action, targetId, JSON.stringify(payload), previousHash, recordHash, createdAt);
    return eventId;
  }

  auditIntegrity(): boolean {
    const rows = this.db.prepare("SELECT * FROM audit_log ORDER BY sequence").all() as Row[];
    let previousHash = "GENESIS";
    for (const row of rows) {
      if (String(row.previous_hash) !== previousHash) return false;
      const body = JSON.stringify({ eventId: String(row.event_id), actor: String(row.actor), action: String(row.action),
        targetId: String(row.target_id), payload: json(row.payload_json!), previousHash, createdAt: String(row.created_at) });
      if (sha256(body) !== String(row.record_hash)) return false;
      previousHash = String(row.record_hash);
    }
    return true;
  }

  // --- Facility query and reservation methods ---

  getFacilitiesByRegion(regionId: string, capability: string): Array<{
    facilityId: string; capability: string; regionId: string; available: number; reserved: number;
  }> {
    return (this.db.prepare(
      "SELECT facility_id,capability,region_id,available,reserved FROM facility_capacity WHERE region_id=? AND capability=? AND available > reserved ORDER BY (available - reserved) DESC"
    ).all(regionId, capability) as Row[]).map((row) => ({
      facilityId: String(row.facility_id), capability: String(row.capability),
      regionId: String(row.region_id), available: Number(row.available), reserved: Number(row.reserved),
    }));
  }

  reserveFacilityCapacity(facilityId: string, capability: string, count: number): boolean {
    const result = this.db.prepare(
      "UPDATE facility_capacity SET reserved=reserved+? WHERE facility_id=? AND capability=? AND (available - reserved) >= ?"
    ).run(count, facilityId, capability, count);
    return Number(result.changes) === 1;
  }

  releaseFacilityCapacity(facilityId: string, capability: string, count: number): boolean {
    const result = this.db.prepare(
      "UPDATE facility_capacity SET reserved=MAX(0,reserved-?) WHERE facility_id=? AND capability=?"
    ).run(count, facilityId, capability);
    return Number(result.changes) === 1;
  }

  upsertFacilityLocation(facilityId: string, regionId: string, latitude: number, longitude: number, name = ""): void {
    this.db.prepare(
      `INSERT INTO facility_locations (facility_id,region_id,latitude,longitude,name) VALUES(?,?,?,?,?)
       ON CONFLICT(facility_id) DO UPDATE SET region_id=excluded.region_id,latitude=excluded.latitude,longitude=excluded.longitude,name=excluded.name`
    ).run(facilityId, regionId, latitude, longitude, name);
  }

  getFacilityLocation(facilityId: string): { latitude: number; longitude: number; regionId: string } | undefined {
    const row = this.db.prepare("SELECT latitude,longitude,region_id FROM facility_locations WHERE facility_id=?").get(facilityId) as Row | undefined;
    if (!row) return undefined;
    return { latitude: Number(row.latitude), longitude: Number(row.longitude), regionId: String(row.region_id) };
  }

  activeAssignmentsInRegion(regionId: string): Array<{ incidentId: string; assignmentId: string; resourceId: string; status: string }> {
    return (this.db.prepare(
      `SELECT a.id, a.incident_id, a.resource_id, a.status FROM assignments a
       JOIN incidents i ON a.incident_id = i.id
       WHERE i.region_id = ? AND a.status IN ('HELD','DISPATCHED','ACCEPTED','EN_ROUTE','ARRIVED','NEED_ASSISTANCE')
       ORDER BY a.incident_id`
    ).all(regionId) as Row[]).map((row) => ({
      assignmentId: String(row.id), incidentId: String(row.incident_id),
      resourceId: String(row.resource_id), status: String(row.status),
    }));
  }
}

function rowToAssignment(row: Row): Assignment {
  return {
    assignmentId: String(row.id), incidentId: String(row.incident_id), resourceId: String(row.resource_id),
    status: String(row.status) as AssignmentStatus, resourceEpoch: Number(row.resource_epoch),
    shardEpoch: Number(row.shard_epoch), resourceVersion: Number(row.resource_version), commandId: String(row.command_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.facility_id ? { facilityId: String(row.facility_id) } : {}),
    ...(row.facility_capability ? { facilityCapability: String(row.facility_capability) } : {}),
  };
}

function resourceStatusForAssignment(status: AssignmentStatus, current: ResourceStatus): ResourceStatus {
  if (status === "DISPATCHED" || status === "ACCEPTED") return "DISPATCHED";
  if (status === "EN_ROUTE" || status === "NEED_ASSISTANCE") return "EN_ROUTE";
  if (status === "ARRIVED") return "ON_SCENE";
  if (status === "COMPLETED") return "RELEASED";
  if (status === "REJECTED" || status === "CANCELLED") {
    if (current === "OUT_OF_SERVICE" || current === "UNKNOWN") return current;
    return current === "EN_ROUTE" || current === "ON_SCENE" || current === "TRANSPORTING" ? "RELEASED" : "AVAILABLE";
  }
  return current;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

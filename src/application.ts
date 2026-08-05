import { join } from "node:path";
import { AppError } from "./domain/errors.ts";
import { DEFAULT_POLICY } from "./domain/policy.ts";
import type {
  AssignmentStatus, IncidentInput, PublicWarningInput, ResourceTelemetryInput,
} from "./domain/types.ts";
import type { AppConfig } from "./config.ts";
import { OperationalDatabase } from "./platform/database.ts";
import { EncryptedEdgeSpool } from "./platform/edgeSpool.ts";
import { BoundedEventBus, OutboxPublisher } from "./platform/eventBus.ts";
import { Metrics } from "./platform/metrics.ts";
import { AdmissionController } from "./platform/priorityQueue.ts";
import { CommandSigner } from "./platform/signing.ts";
import { ShardDirectory } from "./platform/sharding.ts";
import { LocalRoutingService } from "./platform/spatial.ts";
import { DecisionEngine, BoundedOptimizer } from "./services/decision.ts";
import { DispatchService } from "./services/dispatch.ts";
import { IncidentService } from "./services/incidents.ts";
import { MemoryNotificationProvider, NotificationOrchestrator } from "./services/notifications.ts";
import { ResourceIndex, ResourceService } from "./services/resources.ts";
import { ProductionIntegrations } from "./platform/productionIntegrations.ts";
import { uuidv7 } from "./platform/ids.ts";
import { PythonOptimizerClient } from "./services/pythonOptimizer.ts";

export class EmergencyApplication {
  readonly config: AppConfig;
  readonly database: OperationalDatabase;
  readonly metrics = new Metrics();
  readonly eventBus = new BoundedEventBus();
  readonly outbox: OutboxPublisher;
  readonly resources: ResourceService;
  readonly incidents: IncidentService;
  readonly routing = new LocalRoutingService();
  readonly decisions: DecisionEngine;
  readonly optimizer = new BoundedOptimizer();
  readonly notifications: NotificationOrchestrator;
  readonly dispatch: DispatchService;
  readonly shards = new ShardDirectory();
  readonly integrations: ProductionIntegrations;
  readonly pythonOptimizer: PythonOptimizerClient;
  readonly #reoptimizationCooldowns = new Map<string, number>();
  #optimizerHealthTimer?: NodeJS.Timeout;
  #outboxTimer?: NodeJS.Timeout;

  constructor(config: AppConfig, database?: OperationalDatabase) {
    this.config = config;
    this.database = database ?? new OperationalDatabase(config.databasePath);
    this.outbox = new OutboxPublisher(this.database, this.eventBus);
    this.database.recoverInterruptedAllocations();
    const activeEnvironment = this.database.latestActiveEnvironment(config.regionId);
    if (activeEnvironment) {
      this.routing.replaceClosures(activeEnvironment.closedCells, activeEnvironment.mapVersion, activeEnvironment.expiresAt);
    }
    this.integrations = new ProductionIntegrations(config.productionIntegrations);
    this.pythonOptimizer = new PythonOptimizerClient(config.optimizer);
    const index = new ResourceIndex();
    this.resources = new ResourceService(this.database, index);
    this.resources.rebuild(config.regionId);
    const admission = new AdmissionController(config.p0QueueCapacity, config.generalQueueCapacity);
    const spool = config.edgeSpoolKeyHex
      ? new EncryptedEdgeSpool(join(config.databasePath === ":memory:" ? "." : join(config.databasePath, ".."), "edge-spool.ndjson"), config.edgeSpoolKeyHex)
      : undefined;
    this.incidents = new IncidentService(this.database, admission, DEFAULT_POLICY, spool);
    this.decisions = new DecisionEngine(this.routing, DEFAULT_POLICY, this.pythonOptimizer);
    const providers = [
      new MemoryNotificationProvider("primary", ["APP", "SMS", "EOC", "CAP"]),
      new MemoryNotificationProvider("secondary", ["SMS", "EOC", "RADIO"]),
    ];
    this.notifications = new NotificationOrchestrator(this.database, providers);
    this.dispatch = new DispatchService(this.database, new CommandSigner(config.commandSigningKey), this.notifications);
    this.shards.seed(config.regionId, `${config.regionId}-primary`, `${config.regionId}-standby`);
  }

  async reportIncident(input: IncidentInput): Promise<Record<string, unknown>> {
    const start = performance.now();
    const receipt = this.incidents.report(input);
    this.metrics.increment("incident_intake_total", { status: receipt.status, priority: receipt.incident.priority });
    this.metrics.observe("incident_acceptance", performance.now() - start, { priority: receipt.incident.priority });
    if (receipt.status !== "ACCEPTED" || input.autoAllocate === false || !this.config.autoAllocate) return receipt;
    try {
      const allocation = await this.allocate(receipt.incident.incidentId);
      return { ...receipt, allocation };
    } catch (error) {
      // Incident acceptance is already durable. A competing reservation must
      // not turn that receipt into an HTTP failure or leave the incident in
      // ALLOCATING. The caller receives an explicit, replayable contention
      // decision and may retry allocation when another resource is available.
      if (!(error instanceof AppError) || error.code !== "RESOURCE_CONFLICT") throw error;
      const current = this.database.getIncident(receipt.incident.incidentId);
      if (current?.status === "ALLOCATING") {
        this.database.transitionIncident(current.incidentId, current.version, "TRIAGED");
      }
      const attempted = this.database.latestDecisionForIncident(receipt.incident.incidentId);
      if (!attempted) throw error;
      const contentionDecision = {
        ...attempted,
        decisionId: uuidv7(),
        mode: "RESERVATION_CONTENDED" as const,
        generatedAt: new Date().toISOString(),
        chosenResourceIds: [],
        reasons: [...attempted.reasons, "RESOURCE_RESERVATION_CONTENDED", "INCIDENT_RETAINED_FOR_REALLOCATION"],
      };
      this.database.storeDecision(contentionDecision);
      this.#recordDecisionMetrics(contentionDecision);
      this.database.appendAudit("allocation-service", "RESERVATION_CONTENTION", receipt.incident.incidentId, {
        attemptedDecisionId: attempted.decisionId,
        contentionDecisionId: contentionDecision.decisionId,
      });
      return {
        ...receipt,
        allocation: {
          decision: contentionDecision, assignments: [], commands: [], facilityReservations: [],
          reservationStatus: "CONTENDED",
        },
      };
    }
  }

  async allocate(incidentId: string): Promise<Record<string, unknown>> {
    const started = performance.now();
    let incident = this.database.getIncident(incidentId);
    if (!incident) throw new AppError("INCIDENT_NOT_FOUND", "Incident not found", 404);
    if (incident.status === "REPORTED") incident = this.database.transitionIncident(incidentId, incident.version, "TRIAGED");
    if (incident.status === "TRIAGED") incident = this.database.transitionIncident(incidentId, incident.version, "ALLOCATING");
    if (incident.status !== "ALLOCATING") throw new AppError("INCIDENT_NOT_ALLOCATABLE", `Incident is ${incident.status}`, 409);

    let candidates = this.resources.index.search(incident.location, DEFAULT_POLICY.maxCandidateCount);
    if (candidates.length === 0) candidates = this.database.listResources(incident.location.regionId);
    const decision = await this.decisions.decide(incident, candidates, 100, this.database);
    this.database.storeDecision(decision);
    this.#recordDecisionMetrics(decision);
    if (decision.chosenResourceIds.length === 0) {
      this.database.transitionIncident(incidentId, incident.version, "TRIAGED");
      return { decision, assignments: [], commands: [], facilityReservations: [] };
    }
    const selected = decision.chosenResourceIds.map((resourceId) => {
      const candidate = decision.candidates.find((entry) => entry.resourceId === resourceId);
      if (!candidate) throw new AppError("DECISION_INVALID", "Selected resource is not in the candidate set", 500);
      return {
        resourceId,
        expectedVersion: candidate.resourceVersion,
        ...(candidate.destinationFacility ? {
          facilityId: candidate.destinationFacility.facilityId,
          facilityCapability: candidate.destinationFacility.capability,
        } : {}),
      };
    });
    const shardEpoch = this.shards.owner(incident.location.regionId, incident.virtualShard).epoch;
    const assignments = this.database.reserveResources(incidentId, selected, shardEpoch);

    // Reserve facility capacity for assignments that have facility destinations
    const facilityReservations: Array<{ facilityId: string; capability: string; reserved: boolean }> = [];
    for (const assignment of assignments) {
      if (assignment.facilityId && assignment.facilityCapability) {
        const reserved = this.database.reserveFacilityCapacity(assignment.facilityId, assignment.facilityCapability, 1);
        facilityReservations.push({ facilityId: assignment.facilityId, capability: assignment.facilityCapability, reserved });
        if (reserved) {
          this.database.appendAudit("allocation-service", "FACILITY_CAPACITY_RESERVED", assignment.facilityId, {
            assignmentId: assignment.assignmentId, incidentId, facilityId: assignment.facilityId,
            capability: assignment.facilityCapability,
          });
        }
      }
    }

    const commands = await Promise.all(assignments.map((assignment) => this.dispatch.dispatch(
      assignment, decision.policyVersion, incident.responseDeadline,
    )));
    assignments.forEach((assignment) => {
      const current = this.database.getResource(assignment.resourceId);
      if (current) this.resources.index.update(current);
    });
    this.metrics.observe("allocation_reservation", performance.now() - started, { priority: incident.priority });
    // Local commitment is already durable. External replication is handled
    // continuously by the bounded transactional-outbox publisher so network
    // latency cannot delay the emergency response.
    void this.outbox.flush(250);
    return {
      decision,
      assignments: assignments.map((assignment) => this.database.getAssignment(assignment.assignmentId)),
      commands,
      facilityReservations,
    };
  }

  #recordDecisionMetrics(decision: import("./domain/types.ts").DecisionExplanation): void {
    this.metrics.increment("decision_total", { mode: decision.mode });
    if (decision.optimizerEvidence?.fallbackReason) {
      this.metrics.increment("optimizer_fallback_total", { reason: decision.optimizerEvidence.fallbackReason });
    } else if (decision.optimizerEvidence?.algorithm) {
      this.metrics.increment("optimizer_decision_total", { algorithm: decision.optimizerEvidence.algorithm });
      if (decision.optimizerEvidence.durationMs !== undefined) {
        this.metrics.observe("optimizer_solve", decision.optimizerEvidence.durationMs, { algorithm: decision.optimizerEvidence.algorithm });
      }
    }
  }

  acknowledge(input: {
    assignmentId: string; status: AssignmentStatus; highestResourceEpoch: number; highestShardEpoch: number; actor: string;
  }): Record<string, unknown> {
    const assignment = this.dispatch.acknowledge(input);
    const currentResource = this.database.getResource(assignment.resourceId);
    if (currentResource) this.resources.index.update(currentResource);
    const incident = this.database.getIncident(assignment.incidentId);
    if (incident && input.status === "ACCEPTED" && incident.status === "ASSIGNED") {
      this.database.transitionIncident(incident.incidentId, incident.version, "ACTIVE");
    }
    if (incident && input.status === "COMPLETED") {
      const active = this.database.assignmentsForIncident(incident.incidentId)
        .some((item) => !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status));
      const refreshed = this.database.getIncident(incident.incidentId);
      if (!active && refreshed?.status === "ACTIVE") this.database.transitionIncident(refreshed.incidentId, refreshed.version, "RESOLVED");
      // Release facility capacity on completion
      if (assignment.facilityId && assignment.facilityCapability) {
        this.database.releaseFacilityCapacity(assignment.facilityId, assignment.facilityCapability, 1);
      }
    }
    if (incident && (input.status === "CANCELLED" || input.status === "REJECTED")) {
      // Release facility capacity on cancellation/rejection
      if (assignment.facilityId && assignment.facilityCapability) {
        this.database.releaseFacilityCapacity(assignment.facilityId, assignment.facilityCapability, 1);
      }
    }
    return { assignment: this.database.getAssignment(input.assignmentId), incident: this.database.getIncident(assignment.incidentId) };
  }

  updateFacility(input: { facilityId: string; capability: string; regionId: string; available: number; reserved: number; sourceSequence: number;
    latitude?: number; longitude?: number; name?: string }): boolean {
    if (![input.available, input.reserved, input.sourceSequence].every(Number.isInteger) || input.available < 0 || input.reserved < 0) {
      throw new AppError("INVALID_FACILITY_CAPACITY", "Capacity values must be non-negative integers", 422);
    }
    // Upsert facility location if coordinates are provided
    if (input.latitude !== undefined && input.longitude !== undefined) {
      this.database.upsertFacilityLocation(input.facilityId, input.regionId, input.latitude, input.longitude, input.name ?? "");
    }
    const applied = this.database.updateFacilityCapacity(input);
    // Reactive: trigger reoptimization for active incidents if capacity becomes critical
    if (applied && input.available <= input.reserved) {
      this.triggerReactiveReoptimization(input.regionId, "FACILITY_CAPACITY_EXHAUSTED");
    }
    return applied;
  }

  updateEnvironment(input: {
    eventId: string; regionId: string; eventType: string; payload: unknown; mapVersion: string; effectiveAt: string; expiresAt: string;
    closedCells?: string[];
  }): boolean {
    if (Date.parse(input.expiresAt) <= Date.now()) throw new AppError("ENVIRONMENT_EVENT_EXPIRED", "Environment event has expired", 410);
    const applied = this.database.addEnvironmentEvent(input);
    if (applied && input.closedCells) {
      this.routing.replaceClosures(input.closedCells, input.mapVersion, input.expiresAt);
      // Reactive: trigger reoptimization for active incidents affected by road/route closures
      this.triggerReactiveReoptimization(input.regionId, "ROUTE_CLOSURE");
    }
    return applied;
  }

  /**
   * Reactive auto-reoptimization: scans active assignments in the region and
   * triggers recommendation for each affected incident, respecting cooldown
   * to prevent thrashing.
   */
  triggerReactiveReoptimization(regionId: string, reason: string): void {
    const cooldownMs = DEFAULT_POLICY.commitmentHorizonSeconds * 1_000;
    const now = Date.now();
    const activeAssignments = this.database.activeAssignmentsInRegion(regionId);
    const incidentIds = [...new Set(activeAssignments.map((a) => a.incidentId))];
    for (const incidentId of incidentIds) {
      const lastRun = this.#reoptimizationCooldowns.get(incidentId) ?? 0;
      if (now - lastRun < cooldownMs) continue;
      this.#reoptimizationCooldowns.set(incidentId, now);
      this.recommendReoptimization(incidentId).then((recommendation) => {
        this.database.appendAudit("reactive-reoptimization", "REACTIVE_REOPTIMIZATION_TRIGGERED", incidentId, {
          reason, action: recommendation.action,
        });
        this.metrics.increment("reactive_reoptimization_total", { reason, action: String(recommendation.action) });
      }).catch(() => {
        // Reoptimization failure is non-fatal; current assignment stands
      });
    }
  }

  override(input: { actor: string; incidentId: string; reason: string; expectedVersion: number }): string {
    const incident = this.database.getIncident(input.incidentId);
    if (!incident) throw new AppError("INCIDENT_NOT_FOUND", "Incident not found", 404);
    if (incident.version !== input.expectedVersion) throw new AppError("INCIDENT_VERSION_CONFLICT", "Incident version changed", 409);
    return this.database.appendAudit(input.actor, "OPERATOR_OVERRIDE", input.incidentId, input);
  }

  issueWarning(input: PublicWarningInput): string {
    return this.notifications.authorizeWarning(input, new Set(["national-eoc", "regional-eoc", "civil-defence"]));
  }

  systemSnapshot(): ReturnType<OperationalDatabase["operationalSnapshot"]> {
    return this.database.operationalSnapshot(this.config.regionId);
  }

  async start(): Promise<void> {
    await Promise.all([this.integrations.start(this.eventBus, this.config.regionId), this.pythonOptimizer.probe()]);
    this.#optimizerHealthTimer = setInterval(() => { void this.pythonOptimizer.probe(); }, 5_000);
    this.#optimizerHealthTimer.unref();
    void this.outbox.flush(250);
    this.#outboxTimer = setInterval(() => { void this.outbox.flush(250); }, 500);
    this.#outboxTimer.unref();
  }

  platformTopology(): ReturnType<ProductionIntegrations["snapshot"]> & { optimizer: ReturnType<PythonOptimizerClient["snapshot"]> } {
    const topology = this.integrations.snapshot(this.database.pendingOutbox(1_000).length);
    const operational = this.database.operationalSnapshot(this.config.regionId);
    const optimizer = this.pythonOptimizer.snapshot();
    this.metrics.setGauge("emergency_outbox_unpublished_events", topology.retainedOutboxEvents);
    this.metrics.setGauge("emergency_outbox_oldest_unpublished_seconds", operational.eventBacklog.oldestAgeSeconds);
    for (const integration of topology.integrations) {
      this.metrics.setGauge("emergency_integration_up", integration.state === "UP" ? 1 : 0, {
        integration: integration.name,
      });
    }
    this.metrics.setGauge("emergency_optimizer_up", optimizer.state === "UP" ? 1 : 0);
    return { ...topology, optimizer };
  }

  async recommendReoptimization(incidentId: string): Promise<Record<string, unknown>> {
    const incident = this.database.getIncident(incidentId);
    if (!incident) throw new AppError("INCIDENT_NOT_FOUND", "Incident not found", 404);
    const existing = this.database.assignmentsForIncident(incidentId)
      .filter((assignment) => !["COMPLETED", "CANCELLED", "REJECTED"].includes(assignment.status));
    const candidates = this.resources.index.search(incident.location, DEFAULT_POLICY.maxCandidateCount);
    const proposed = await this.decisions.decide(incident, candidates, 500, this.database);
    const improved = this.optimizer.improve(proposed, Math.max(0, 500 - proposed.durationMs));
    const commitmentReached = existing.some((assignment) => ["ACCEPTED", "EN_ROUTE", "ARRIVED", "NEED_ASSISTANCE"].includes(assignment.status));
    const currentDecision = this.database.latestDecisionForIncident(incidentId);
    const currentScore = currentDecision?.candidates.find((candidate) => currentDecision.chosenResourceIds.includes(candidate.resourceId))?.score;
    const proposedScore = improved.candidates.find((candidate) => improved.chosenResourceIds.includes(candidate.resourceId))?.score;
    const improvement = currentScore && proposedScore !== undefined ? (currentScore - proposedScore) / Math.max(1, currentScore) : 0;
    const materiallyBetter = improvement >= DEFAULT_POLICY.reassignmentMinimumImprovement;
    const requiresOperatorApproval = existing.length > 0;
    const recommendation = {
      decision: improved, existingAssignments: existing, improvement,
      materiallyBetter, commitmentReached, requiresOperatorApproval,
      action: commitmentReached ? "KEEP_CURRENT_ASSIGNMENT" : materiallyBetter ? "OPERATOR_APPROVAL_REQUIRED" : "NO_CHANGE",
    };
    this.database.storeDecision({
      ...improved,
      reasons: [...improved.reasons, recommendation.action],
    });
    this.database.appendAudit("reoptimization-service", "REOPTIMIZATION_EVALUATED", incidentId, {
      improvement, materiallyBetter, commitmentReached, action: recommendation.action,
    });
    this.metrics.observe("reoptimization", improved.durationMs, { action: recommendation.action });
    return recommendation;
  }

  async shutdown(): Promise<void> {
    if (this.#optimizerHealthTimer) clearInterval(this.#optimizerHealthTimer);
    if (this.#outboxTimer) clearInterval(this.#outboxTimer);
    await this.outbox.flush(1_000);
    await this.integrations.close();
  }

  close(): void { this.database.close(); }
}

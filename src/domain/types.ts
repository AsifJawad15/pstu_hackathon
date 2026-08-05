export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const INCIDENT_STATUSES = [
  "REPORTED", "TRIAGED", "ALLOCATING", "ASSIGNED", "ACTIVE", "RESOLVED", "CANCELLED",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const RESOURCE_STATUSES = [
  "AVAILABLE", "HELD", "DISPATCHED", "EN_ROUTE", "ON_SCENE", "TRANSPORTING",
  "AT_FACILITY", "RELEASED", "OUT_OF_SERVICE", "UNKNOWN",
] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  "HELD", "DISPATCHED", "ACCEPTED", "REJECTED", "EN_ROUTE", "ARRIVED",
  "NEED_ASSISTANCE", "COMPLETED", "CANCELLED",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export type GeoPoint = {
  latitude: number;
  longitude: number;
  regionId: string;
  uncertaintyMeters?: number;
};

export type EventMetadata = {
  eventId: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  schemaVersion: number;
  aggregateVersion: number;
  policyVersion: string;
  mapVersion: string;
  resourceEpoch: number;
  shardEpoch: number;
  sourceTime: string;
  effectiveTime: string;
  expiryTime?: string;
  authority: string;
  traceId: string;
  signature?: string;
  sourceSequence?: number;
};

export type IncidentInput = {
  incidentId?: string;
  metadata: EventMetadata;
  location: GeoPoint;
  severity: number;
  affectedPeople: number;
  timeToHarmMinutes: number;
  requiredCapabilities: string[];
  requiredCapacity?: number;
  hazards: string[];
  vulnerableGroups?: string[];
  environmentalEscalation?: number;
  confidence: number;
  responseDeadline: string;
  autoAllocate?: boolean;
};

export type Incident = Required<Pick<IncidentInput, "incidentId">> & IncidentInput & {
  priority: Priority;
  priorityScore: number;
  status: IncidentStatus;
  version: number;
  virtualShard: number;
  acceptedAt: string;
};

export const TRANSPORT_MODES = ["GROUND", "AIR", "WATER"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export type ResourceTelemetryInput = {
  resourceId: string;
  metadata: EventMetadata;
  location: GeoPoint;
  resourceType: string;
  capabilities: string[];
  capacity: number;
  status: ResourceStatus;
  healthy: boolean;
  maintenance: boolean;
  sourceSequence: number;
  jurisdiction: string;
  crewAvailable: boolean;
  weatherRestricted?: boolean;
  transportMode?: TransportMode;
  hazardTolerances?: string[];
};

export type Resource = ResourceTelemetryInput & {
  version: number;
  epoch: number;
  virtualShard: number;
  updatedAt: string;
  spatialCell: string;
};

export type FacilityCandidate = {
  facilityId: string;
  capability: string;
  regionId: string;
  available: number;
  reserved: number;
  distanceMeters: number;
  etaSeconds: number;
  score: number;
};

export type FacilityReservation = {
  facilityId: string;
  capability: string;
  count: number;
  reservedAt: string;
};

export type CandidateScore = {
  resourceId: string;
  feasible: boolean;
  exclusionReasons: string[];
  etaSeconds: number;
  distanceMeters: number;
  routeConfidence: number;
  routeSource: "LOCAL_MATRIX" | "LOCAL_GRAPH" | "GEOMETRIC_FALLBACK";
  score: number;
  components: {
    eta: number;
    routeRisk: number;
    scarcity: number;
    coverageLoss: number;
    handover: number;
  };
  resourceVersion: number;
  resourceEpoch: number;
  destinationFacility?: FacilityCandidate;
};

export type DecisionExplanation = {
  decisionId: string;
  incidentId: string;
  mode: "DETERMINISTIC" | "EXACT_OPTIMIZED" | "PYTHON_INCUMBENT" | "BOUNDED_IMPROVEMENT"
    | "NO_FEASIBLE_RESOURCE" | "RESERVATION_CONTENDED";
  policyVersion: string;
  mapVersion: string;
  generatedAt: string;
  deadlineMs: number;
  durationMs: number;
  chosenResourceIds: string[];
  candidates: CandidateScore[];
  reasons: string[];
  snapshotVersions: Record<string, number>;
  facilityReservations?: FacilityReservation[];
  facilityDiversionReason?: string;
  optimizerEvidence?: {
    service: "aegis-python-optimizer";
    solverVersion?: string;
    algorithm?: string;
    objective?: number;
    optimal?: boolean;
    examinedStates?: number;
    durationMs?: number;
    fallbackReason?: string;
  };
};

export type Assignment = {
  assignmentId: string;
  incidentId: string;
  resourceId: string;
  status: AssignmentStatus;
  resourceEpoch: number;
  shardEpoch: number;
  resourceVersion: number;
  commandId: string;
  createdAt: string;
  updatedAt: string;
  facilityId?: string;
  facilityCapability?: string;
};

export type DispatchCommand = {
  commandId: string;
  assignmentId: string;
  incidentId: string;
  resourceId: string;
  action: "DISPATCH" | "REDIRECT" | "CANCEL";
  sequence: number;
  resourceEpoch: number;
  shardEpoch: number;
  policyVersion: string;
  deadline: string;
  signature: string;
};

export type NotificationStatus = "QUEUED" | "SENDING" | "ACCEPTED" | "DELIVERED" | "ACKNOWLEDGED" | "FAILED" | "EXPIRED" | "CANCELLED";

export type PublicWarningInput = {
  warningId?: string;
  authority: string;
  severity: Priority;
  area: GeoPoint & { radiusMeters: number };
  headline: string;
  instruction: string;
  expiresAt: string;
  channels: string[];
  supersedes?: string;
};

import { AppError } from "./errors.ts";
import type { AssignmentStatus, IncidentStatus, ResourceStatus } from "./types.ts";

const incidentTransitions: Record<IncidentStatus, ReadonlySet<IncidentStatus>> = {
  REPORTED: new Set(["TRIAGED", "CANCELLED"]),
  TRIAGED: new Set(["ALLOCATING", "CANCELLED"]),
  ALLOCATING: new Set(["ASSIGNED", "TRIAGED", "CANCELLED"]),
  ASSIGNED: new Set(["ACTIVE", "TRIAGED", "CANCELLED"]),
  ACTIVE: new Set(["RESOLVED", "CANCELLED"]),
  RESOLVED: new Set(),
  CANCELLED: new Set(),
};

const resourceTransitions: Record<ResourceStatus, ReadonlySet<ResourceStatus>> = {
  AVAILABLE: new Set(["HELD", "OUT_OF_SERVICE", "UNKNOWN"]),
  HELD: new Set(["AVAILABLE", "DISPATCHED", "OUT_OF_SERVICE", "UNKNOWN"]),
  DISPATCHED: new Set(["EN_ROUTE", "AVAILABLE", "OUT_OF_SERVICE", "UNKNOWN"]),
  EN_ROUTE: new Set(["ON_SCENE", "RELEASED", "OUT_OF_SERVICE", "UNKNOWN"]),
  ON_SCENE: new Set(["TRANSPORTING", "RELEASED", "OUT_OF_SERVICE", "UNKNOWN"]),
  TRANSPORTING: new Set(["AT_FACILITY", "OUT_OF_SERVICE", "UNKNOWN"]),
  AT_FACILITY: new Set(["RELEASED", "OUT_OF_SERVICE"]),
  RELEASED: new Set(["AVAILABLE", "OUT_OF_SERVICE"]),
  OUT_OF_SERVICE: new Set(["AVAILABLE", "UNKNOWN"]),
  UNKNOWN: new Set(["AVAILABLE", "OUT_OF_SERVICE"]),
};

const assignmentTransitions: Record<AssignmentStatus, ReadonlySet<AssignmentStatus>> = {
  HELD: new Set(["DISPATCHED", "CANCELLED"]),
  DISPATCHED: new Set(["ACCEPTED", "REJECTED", "CANCELLED"]),
  ACCEPTED: new Set(["EN_ROUTE", "REJECTED", "NEED_ASSISTANCE", "CANCELLED"]),
  REJECTED: new Set(),
  EN_ROUTE: new Set(["ARRIVED", "NEED_ASSISTANCE", "CANCELLED"]),
  ARRIVED: new Set(["NEED_ASSISTANCE", "COMPLETED"]),
  NEED_ASSISTANCE: new Set(["EN_ROUTE", "ARRIVED", "COMPLETED", "CANCELLED"]),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};

function assertTransition<T extends string>(name: string, table: Record<T, ReadonlySet<T>>, from: T, to: T): void {
  if (from === to) return;
  if (!table[from]?.has(to)) {
    throw new AppError("INVALID_STATE_TRANSITION", `${name} cannot transition from ${from} to ${to}`, 409);
  }
}

export const assertIncidentTransition = (from: IncidentStatus, to: IncidentStatus) =>
  assertTransition("incident", incidentTransitions, from, to);

export const assertResourceTransition = (from: ResourceStatus, to: ResourceStatus) =>
  assertTransition("resource", resourceTransitions, from, to);

export const assertAssignmentTransition = (from: AssignmentStatus, to: AssignmentStatus) =>
  assertTransition("assignment", assignmentTransitions, from, to);

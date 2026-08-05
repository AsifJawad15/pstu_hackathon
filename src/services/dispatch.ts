import { AppError } from "../domain/errors.ts";
import type { Assignment, AssignmentStatus, DispatchCommand } from "../domain/types.ts";
import type { OperationalDatabase } from "../platform/database.ts";
import type { CommandSigner } from "../platform/signing.ts";
import type { NotificationOrchestrator } from "./notifications.ts";

export class DispatchService {
  readonly #sequenceByResource = new Map<string, number>();
  readonly #highestEpochByResource = new Map<string, { resourceEpoch: number; shardEpoch: number }>();
  readonly #database: OperationalDatabase;
  readonly #signer: CommandSigner;
  readonly #notifications: NotificationOrchestrator;

  constructor(
    database: OperationalDatabase,
    signer: CommandSigner,
    notifications: NotificationOrchestrator,
  ) {
    this.#database = database;
    this.#signer = signer;
    this.#notifications = notifications;
  }

  async dispatch(assignment: Assignment, policyVersion: string, deadline: string): Promise<DispatchCommand> {
    const sequence = (this.#sequenceByResource.get(assignment.resourceId) ?? 0) + 1;
    const unsigned = {
      commandId: assignment.commandId, assignmentId: assignment.assignmentId, incidentId: assignment.incidentId,
      resourceId: assignment.resourceId, action: "DISPATCH" as const, sequence,
      resourceEpoch: assignment.resourceEpoch, shardEpoch: assignment.shardEpoch, policyVersion, deadline,
    };
    const command: DispatchCommand = { ...unsigned, signature: this.#signer.sign(unsigned) };
    const transitioned = this.#database.transitionAssignment(assignment.assignmentId, "DISPATCHED");
    this.#sequenceByResource.set(assignment.resourceId, sequence);
    this.#highestEpochByResource.set(assignment.resourceId, {
      resourceEpoch: transitioned.resourceEpoch, shardEpoch: transitioned.shardEpoch,
    });
    this.#database.appendAudit("dispatch-service", "COMMAND_ISSUED", command.commandId, command);

    const expiresAt = deadline;
    const channels = ["APP", "SMS", "EOC"];
    await Promise.allSettled(channels.map((channel) => this.#notifications.send({
      notificationId: command.commandId, recipientId: assignment.resourceId, channel, version: sequence,
      expiresAt, payload: command,
    })));
    return command;
  }

  acknowledge(input: {
    assignmentId: string; status: AssignmentStatus; highestResourceEpoch: number; highestShardEpoch: number; actor: string;
  }): Assignment {
    const assignment = this.#database.getAssignment(input.assignmentId);
    if (!assignment) throw new AppError("ASSIGNMENT_NOT_FOUND", "Assignment not found", 404);
    if (input.highestResourceEpoch < assignment.resourceEpoch || input.highestShardEpoch < assignment.shardEpoch) {
      throw new AppError("STALE_FENCING_EPOCH", "Acknowledgement carries a stale ownership epoch", 409);
    }
    const known = this.#highestEpochByResource.get(assignment.resourceId);
    if (known && (input.highestResourceEpoch < known.resourceEpoch || input.highestShardEpoch < known.shardEpoch)) {
      throw new AppError("STALE_FENCING_EPOCH", "Acknowledgement is older than the accepted device epoch", 409);
    }
    const next = this.#database.transitionAssignment(input.assignmentId, input.status);
    this.#database.appendAudit(input.actor, `DISPATCH_${input.status}`, input.assignmentId, input);
    return next;
  }
}

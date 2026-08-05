import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmergencyApplication } from "./application.ts";
import { AppError } from "./domain/errors.ts";
import type { AssignmentStatus, IncidentInput, PublicWarningInput, ResourceTelemetryInput } from "./domain/types.ts";

const MAX_BODY_BYTES = 256 * 1024;

export function createHttpServer(app: EmergencyApplication) {
  return createServer(async (request, response) => {
    const started = performance.now();
    const requestId = String(request.headers["x-request-id"] ?? randomUUID());
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("cache-control", "no-store");
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health/live") return send(response, 200, { status: "UP" });
      if (request.method === "GET" && url.pathname === "/health/ready") {
        return send(response, 200, { status: "READY", regionId: app.config.regionId, auditIntegrity: app.database.auditIntegrity() });
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        return response.end(app.metrics.prometheus());
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/console.js" || url.pathname === "/styles.css")) {
        return serveConsole(url.pathname, response);
      }
      authenticate(request, app.config.apiToken);

      if (request.method === "POST" && url.pathname === "/v1/incidents") {
        return send(response, 202, await app.reportIncident(await readJson<IncidentInput>(request)));
      }
      const incidentUpdate = url.pathname.match(/^\/v1\/incidents\/([^/]+)\/update$/);
      if (request.method === "POST" && incidentUpdate) {
        const body = await readJson<{ expectedVersion: number; patch: Parameters<typeof app.incidents.update>[2] }>(request);
        return send(response, 200, app.incidents.update(decodeURIComponent(incidentUpdate[1]!), body.expectedVersion, body.patch));
      }
      const incidentCancel = url.pathname.match(/^\/v1\/incidents\/([^/]+)\/cancel$/);
      if (request.method === "POST" && incidentCancel) {
        const body = await readJson<{ expectedVersion: number; actor: string; reason: string }>(request);
        return send(response, 200, app.incidents.cancel(decodeURIComponent(incidentCancel[1]!), body.expectedVersion, body.actor, body.reason));
      }
      const allocate = url.pathname.match(/^\/v1\/incidents\/([^/]+)\/allocate$/);
      if (request.method === "POST" && allocate) {
        return send(response, 200, await app.allocate(decodeURIComponent(allocate[1]!)));
      }
      const reoptimize = url.pathname.match(/^\/v1\/incidents\/([^/]+)\/reoptimize$/);
      if (request.method === "POST" && reoptimize) {
        return send(response, 200, await app.recommendReoptimization(decodeURIComponent(reoptimize[1]!)));
      }
      const incidentGet = url.pathname.match(/^\/v1\/incidents\/([^/]+)$/);
      if (request.method === "GET" && incidentGet) {
        const incident = app.database.getIncident(decodeURIComponent(incidentGet[1]!));
        if (!incident) throw new AppError("INCIDENT_NOT_FOUND", "Incident not found", 404);
        return send(response, 200, { incident, assignments: app.database.assignmentsForIncident(incident.incidentId) });
      }
      if (request.method === "POST" && url.pathname === "/v1/resources/telemetry") {
        return send(response, 202, app.resources.ingest(await readJson<ResourceTelemetryInput>(request)));
      }
      if (request.method === "POST" && url.pathname === "/v1/facilities/capacity") {
        return send(response, 202, { applied: app.updateFacility(await readJson(request)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/environment") {
        return send(response, 202, { applied: app.updateEnvironment(await readJson(request)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/dispatch/acknowledgements") {
        const body = await readJson<{
          assignmentId: string; status: AssignmentStatus; highestResourceEpoch: number; highestShardEpoch: number; actor: string;
        }>(request);
        return send(response, 200, app.acknowledge(body));
      }
      const decision = url.pathname.match(/^\/v1\/decisions\/([^/]+)$/);
      if (request.method === "GET" && decision) {
        const value = app.database.getDecision(decodeURIComponent(decision[1]!));
        if (!value) throw new AppError("DECISION_NOT_FOUND", "Decision not found", 404);
        return send(response, 200, value);
      }
      if (request.method === "POST" && url.pathname === "/v1/overrides") {
        return send(response, 201, { auditEventId: app.override(await readJson(request)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/warnings") {
        return send(response, 201, { warningId: app.issueWarning(await readJson<PublicWarningInput>(request)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/outbox/flush") {
        return send(response, 200, await app.outbox.flush());
      }
      throw new AppError("NOT_FOUND", "Route not found", 404);
    } catch (error) {
      const status = error instanceof AppError ? error.status : Number((error as { status?: number }).status ?? 500);
      const code = error instanceof AppError ? error.code : String((error as { code?: string }).code ?? "INTERNAL_ERROR");
      const message = status >= 500 ? "Request could not be completed" : error instanceof Error ? error.message : "Invalid request";
      send(response, status, { error: { code, message, requestId } });
    } finally {
      app.metrics.increment("http_requests_total", { method: request.method ?? "UNKNOWN", status: String(response.statusCode) });
      app.metrics.observe("http_request", performance.now() - started, { method: request.method ?? "UNKNOWN" });
    }
  });
}

function authenticate(request: IncomingMessage, expectedToken: string): void {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new AppError("UNAUTHENTICATED", "Bearer token required", 401);
  const actual = Buffer.from(value.slice(7));
  const expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError("UNAUTHENTICATED", "Invalid bearer token", 401);
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Request exceeds 256 KiB", 413);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Request exceeds 256 KiB", 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new AppError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function serveConsole(pathname: string, response: ServerResponse): void {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const contentType = file.endsWith(".js") ? "text/javascript; charset=utf-8"
    : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
  try {
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
    response.end(readFileSync(join(process.cwd(), "web", file)));
  } catch {
    throw new AppError("NOT_FOUND", "Console asset not found", 404);
  }
}

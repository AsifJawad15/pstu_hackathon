const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  token: sessionStorage.getItem("aegis-api-token") ?? "",
  region: sessionStorage.getItem("aegis-region") ?? "region-a",
  connected: false,
  busy: false,
  currentIncidentId: "",
  resources: [],
  baseline: null,
};

$("#token").value = state.token;
$("#region").value = state.region;

function clockTick() {
  $("#clock").textContent = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
}
clockTick();
setInterval(clockTick, 1_000);

class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const headers = { ...(options.authenticated === false ? {} : { authorization: `Bearer ${state.token}` }) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  try {
    const response = await fetch(path, {
      method: options.method ?? "GET", headers, signal: controller.signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!response.ok && !(options.acceptStatuses ?? []).includes(response.status)) {
      throw new ApiError(data?.error?.message ?? `Request failed with ${response.status}`, response.status,
        data?.error?.code ?? "HTTP_ERROR", data);
    }
    return { status: response.status, data };
  } catch (error) {
    if (error?.name === "AbortError") throw new ApiError("Request deadline exceeded", 408, "CLIENT_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshHealth() {
  try {
    const { data } = await api("/health/ready", { authenticated: false, timeoutMs: 2_000 });
    const healthy = data.status === "READY" && data.auditIntegrity === true;
    $("#health").className = `status-pill ${healthy ? "healthy" : "danger"}`;
    $("#health").innerHTML = `<i></i>${healthy ? "System ready" : "Audit warning"}`;
  } catch {
    $("#health").className = "status-pill danger";
    $("#health").innerHTML = "<i></i>System offline";
  }
}

async function connect() {
  const token = $("#token").value.trim();
  const region = $("#region").value.trim();
  if (!token || !region) return toast("Enter the API token and region.", true);
  state.token = token;
  state.region = region;
  $("#connect").disabled = true;
  $("#connection-message").textContent = "Authenticating…";
  try {
    const [snapshot, topology] = await Promise.all([
      api("/v1/system/snapshot"), api("/v1/platform/topology"),
    ]);
    state.connected = true;
    sessionStorage.setItem("aegis-api-token", token);
    sessionStorage.setItem("aegis-region", region);
    $("#connection-message").textContent = "Secure link established";
    $("#rail-region").textContent = snapshot.data.regionId;
    $("#rail-signal").classList.add("online");
    renderSnapshot(snapshot.data);
    renderTopology(topology.data);
    toast(`Connected to ${snapshot.data.regionId}.`);
  } catch (error) {
    state.connected = false;
    $("#connection-message").textContent = error.code === "UNAUTHENTICATED" ? "Token rejected" : "Connection failed";
    toast(formatError(error), true);
  } finally {
    $("#connect").disabled = false;
  }
}

async function refreshTopology({ silent = false } = {}) {
  if (!state.connected) return;
  try {
    const { data } = await api("/v1/platform/topology");
    renderTopology(data);
  } catch (error) {
    if (!silent) toast(formatError(error), true);
  }
}

function renderTopology(topology) {
  $("#topology-mode").textContent = topology.mode === "PRODUCTION_DEMO" ? "PRODUCTION SERVICES CONNECTED" : "LOCAL REFERENCE MODE";
  $("#topology-mode").className = `mode-badge ${topology.overall.toLowerCase().replace("_", "-")}`;
  $("#topology-overall").textContent = topology.overall;
  $("#topology-overall").className = topology.overall.toLowerCase().replace("_", "-");
  $("#topology-authority").textContent = topology.localAuthority;
  $("#topology-backlog").textContent = `${topology.retainedOutboxEvents.toLocaleString()} retained`;
  $("#topology-published").textContent = topology.publishedEvents.toLocaleString();
  $("#topology-last-published").textContent = topology.lastPublishedAt ? relativeTime(topology.lastPublishedAt) : "No publish yet";
  for (const integration of topology.integrations) {
    const status = $(`#integration-${integration.name}`);
    if (!status) continue;
    status.textContent = integration.state;
    status.className = integration.state.toLowerCase().replace("_", "-");
    status.title = integration.lastError ?? integration.purpose;
    status.closest("article").className = integration.state.toLowerCase().replace("_", "-");
  }
  if (topology.optimizer) {
    const status = $("#integration-optimizer");
    status.textContent = topology.optimizer.state;
    status.className = topology.optimizer.state.toLowerCase().replace("_", "-");
    status.title = topology.optimizer.lastError ?? `${topology.optimizer.algorithm} · circuit ${topology.optimizer.circuit}`;
    status.closest("article").className = topology.optimizer.state.toLowerCase().replace("_", "-");
    $("#optimizer-calls").textContent = topology.optimizer.calls.toLocaleString();
  }
}

async function flushRetainedEvents() {
  requireConnection();
  $("#flush-outbox").disabled = true;
  try {
    const { data } = await api("/v1/outbox/flush", { method: "POST", timeoutMs: 15_000 });
    logEvent("Outbox recovery", `${data.published} published · ${data.failed} retained`, data.failed ? "DEGRADED" : "RECOVERED");
    toast(`${data.published} event(s) published; ${data.failed} remain retained.`, data.failed > 0);
    await Promise.all([refreshSnapshot({ silent: true }), refreshTopology({ silent: true })]);
  } catch (error) {
    toast(formatError(error), true);
  } finally {
    $("#flush-outbox").disabled = false;
  }
}

async function refreshSnapshot({ silent = false } = {}) {
  if (!state.connected || state.busy) return;
  try {
    const { data } = await api("/v1/system/snapshot");
    renderSnapshot(data);
  } catch (error) {
    if (!silent) toast(formatError(error), true);
    if (error.status === 401) state.connected = false;
  }
}

function renderSnapshot(snapshot) {
  $("#metric-p0").textContent = snapshot.incidents.p0Active.toLocaleString();
  $("#metric-resources").textContent = snapshot.resources.available.toLocaleString();
  $("#metric-resources-detail").textContent = `${snapshot.resources.total} total regional assets`;
  $("#metric-assignments").textContent = snapshot.assignments.active.toLocaleString();
  const headroom = Math.max(0, snapshot.facilities.available - snapshot.facilities.reserved);
  $("#metric-facilities").textContent = headroom.toLocaleString();
  $("#metric-backlog").textContent = snapshot.eventBacklog.pending.toLocaleString();
  $("#metric-backlog-detail").textContent = snapshot.eventBacklog.pending
    ? `oldest ${snapshot.eventBacklog.oldestAgeSeconds.toFixed(1)}s` : "outbox fully published";
  const coverage = snapshot.resources.total === 0 ? 0 : Math.round(snapshot.resources.available / snapshot.resources.total * 100);
  const deployed = Object.entries(snapshot.resources.byStatus)
    .filter(([status]) => ["HELD", "DISPATCHED", "EN_ROUTE", "ON_SCENE", "TRANSPORTING", "AT_FACILITY"].includes(status))
    .reduce((sum, [, count]) => sum + Number(count), 0);
  const unavailable = snapshot.resources.total - snapshot.resources.available - deployed;
  $("#coverage-value").textContent = `${coverage}% · ${snapshot.resources.available}/${snapshot.resources.total} available`;
  $("#coverage-value").title = `${deployed} deployed · ${Math.max(0, unavailable)} unavailable`;
  $("#rail-region").textContent = snapshot.regionId;
  renderIncidentTable(snapshot.recentIncidents);
}

function renderIncidentTable(incidents) {
  const body = $("#incident-table");
  if (!incidents.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-cell">No incidents in this regional cell.</td></tr>';
    return;
  }
  body.replaceChildren(...incidents.map((incident) => {
    const row = document.createElement("tr");
    row.dataset.incidentId = incident.incidentId;
    const shortId = `${incident.incidentId.slice(0, 8)}…`;
    row.innerHTML = `<td><span class="priority ${escapeText(incident.priority)}">${escapeText(incident.priority)}</span></td>
      <td><span class="incident-link">${escapeText(shortId)}</span></td><td><span class="state">${escapeText(incident.status)}</span></td>
      <td>${Number(incident.affectedPeople).toLocaleString()}</td><td>${relativeTime(incident.acceptedAt)}</td>`;
    return row;
  }));
}

function metadata(kind = "console") {
  const timestamp = new Date().toISOString();
  return {
    eventId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: `${kind}-${crypto.randomUUID()}`,
    schemaVersion: 1, aggregateVersion: 1, policyVersion: "policy-1", mapVersion: "map-1",
    resourceEpoch: 0, shardEpoch: 1, sourceTime: timestamp, effectiveTime: timestamp,
    authority: "regional-eoc", traceId: crypto.randomUUID(),
  };
}

function point(offset = 0) {
  return { latitude: 22.47 + offset, longitude: 91.78 + offset, regionId: state.region };
}

async function prepareBaseline({ quiet = false, capabilityPrefix = "" } = {}) {
  requireConnection();
  const stamp = Date.now().toString(36);
  const prefix = capabilityPrefix || `DEMO-${stamp}`;
  const definitions = [
    { role: "ambulance", type: "AMBULANCE", capabilities: ["ALS", `${prefix}-ALS`], capacity: 12, transportMode: "GROUND", offset: .01 },
    { role: "rescue", type: "RESCUE_TEAM", capabilities: ["RESCUE", `${prefix}-RESCUE`], capacity: 20, transportMode: "GROUND", offset: .014 },
    { role: "helicopter", type: "HELICOPTER", capabilities: ["ALS", "AIR_EVAC", `${prefix}-ALS`, `${prefix}-AIR`], capacity: 8, transportMode: "AIR", offset: .025,
      hazardTolerances: ["HAZARD_FLOOD", "HAZARD_ROAD_COLLAPSE"] },
  ];
  const created = await Promise.all(definitions.map(async (definition, index) => {
    const resourceId = `${definition.role}-${stamp}-${index}`;
    const input = {
      resourceId, metadata: metadata("resource"), location: point(definition.offset), resourceType: definition.type,
      capabilities: definition.capabilities, capacity: definition.capacity, status: "AVAILABLE", healthy: true,
      maintenance: false, sourceSequence: 1, jurisdiction: state.region, crewAvailable: true,
      transportMode: definition.transportMode, ...(definition.hazardTolerances ? { hazardTolerances: definition.hazardTolerances } : {}),
    };
    await api("/v1/resources/telemetry", { method: "POST", body: input });
    return { ...input, role: definition.role };
  }));
  state.resources.push(...created);
  state.baseline = {
    als: `${prefix}-ALS`, rescue: `${prefix}-RESCUE`, air: `${prefix}-AIR`,
  };
  const facilityId = `regional-trauma-${stamp}`;
  await api("/v1/facilities/capacity", { method: "POST", body: {
    facilityId, capability: "HOSPITAL_CARE", regionId: state.region, available: 30, reserved: 2,
    sourceSequence: Date.now(), ...point(-.008), name: "Regional Trauma Centre",
  } });
  logEvent("Baseline ready", `${created.length} resources + trauma facility`, "PASS");
  if (!quiet) toast("Operational baseline prepared.");
  await refreshSnapshot({ silent: true });
  return { prefix, resources: created, facilityId };
}

async function runScenario(action) {
  setScenarioBusy(true);
  try {
    requireConnection();
    if (action === "medical") await reportIncident({
      severity: 9, affectedPeople: 1, timeToHarmMinutes: 5,
      requiredCapabilities: [state.baseline?.als ?? "ALS"], requiredCapacity: 1,
      hazards: [], confidence: .96, label: "Critical medical incident",
    });
    if (action === "mass") await reportIncident({
      severity: 10, affectedPeople: 48, timeToHarmMinutes: 3,
      requiredCapabilities: [state.baseline?.als ?? "ALS", state.baseline?.rescue ?? "RESCUE"], requiredCapacity: 5,
      hazards: [], vulnerableGroups: ["children", "elderly"], environmentalEscalation: .8, confidence: .94,
      label: "Mass-casualty incident",
    });
    if (action === "closure") await triggerRoadClosure();
    if (action === "hospital") await saturateHospital();
    if (action === "failure") await failVehicle();
    if (action === "reoptimize") await reoptimize();
    await refreshSnapshot({ silent: true });
  } catch (error) {
    logEvent("Operation failed", formatError(error), "FAIL", true);
    toast(formatError(error), true);
  } finally {
    setScenarioBusy(false);
  }
}

async function reportIncident(input) {
  const { label, ...facts } = input;
  const started = performance.now();
  const response = await api("/v1/incidents", { method: "POST", body: {
    metadata: metadata("incident"), location: point(), ...facts,
    responseDeadline: new Date(Date.now() + 30 * 60_000).toISOString(), autoAllocate: true,
  } });
  const data = response.data;
  state.currentIncidentId = data.incident.incidentId;
  $("#incident-id").value = state.currentIncidentId;
  renderEvidence({ incident: data.incident, assignments: data.allocation?.assignments ?? [], decision: data.allocation?.decision });
  const count = data.allocation?.assignments?.length ?? 0;
  const roundTripMs = Math.round(performance.now() - started);
  const decisionMs = Math.round((data.allocation?.decision?.durationMs ?? 0) * 10) / 10;
  logEvent(label, `${data.incident.priority} · ${count} assignment${count === 1 ? "" : "s"} · ${roundTripMs} ms end-to-end · ${decisionMs} ms decision`, count ? "DISPATCHED" : "NO FEASIBLE");
  toast(`${label}: ${data.incident.priority}, ${count} assignment${count === 1 ? "" : "s"}.`);
  return data;
}

async function triggerRoadClosure() {
  const closedCell = spatialCell(point());
  const { data } = await api("/v1/environment", { method: "POST", body: {
    eventId: `closure-${crypto.randomUUID()}`, regionId: state.region, eventType: "ROAD_CLOSURE",
    payload: { description: "Primary access corridor unavailable", source: "console-scenario" },
    mapVersion: `map-${Date.now()}`, effectiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), closedCells: [closedCell],
  } });
  logEvent("Road closure", `${closedCell} · reactive evaluation ${data.applied ? "triggered" : "ignored"}`, data.applied ? "APPLIED" : "NO CHANGE");
  toast("Road closure applied; ground routing is now constrained.");
}

async function saturateHospital() {
  const { data } = await api("/v1/facilities/capacity", { method: "POST", body: {
    facilityId: "regional-trauma-saturation", capability: "HOSPITAL_CARE", regionId: state.region,
    available: 12, reserved: 12, sourceSequence: Date.now(), ...point(-.008), name: "Regional Trauma Centre",
  } });
  logEvent("Hospital saturated", "0 beds headroom · reactive evaluation requested", data.applied ? "APPLIED" : "NO CHANGE");
  toast("Hospital capacity set to fully reserved.");
}

async function failVehicle() {
  const target = [...state.resources].reverse().find((resource) => resource.transportMode === "GROUND");
  if (!target) throw new Error("Prepare a baseline before simulating vehicle failure.");
  target.sourceSequence += 1;
  target.status = "OUT_OF_SERVICE";
  target.healthy = false;
  target.metadata = metadata("failure");
  const { data } = await api("/v1/resources/telemetry", { method: "POST", body: target });
  logEvent("Vehicle failure", `${target.resourceId} removed from candidate pool`, data.applied ? "APPLIED" : "IGNORED");
  toast(`${target.resourceId} is now out of service.`);
}

async function reoptimize() {
  if (!state.currentIncidentId) throw new Error("Create or inspect an incident before re-optimizing.");
  const { data } = await api(`/v1/incidents/${encodeURIComponent(state.currentIncidentId)}/reoptimize`, { method: "POST" });
  logEvent("Re-optimization", `${data.action} · improvement ${Math.round((data.improvement ?? 0) * 100)}%`, "EXPLAINED");
  renderEvidence({ incident: { incidentId: state.currentIncidentId, priority: "—", status: "ACTIVE" },
    assignments: data.existingAssignments ?? [], decision: data.decision, recommendation: data });
  toast(`Re-optimization result: ${data.action}.`);
}

async function inspectIncident(id = $("#incident-id").value.trim()) {
  $("#lookup").disabled = true;
  try {
    requireConnection();
    if (!id) return toast("Enter or select an incident ID.", true);
    const { data } = await api(`/v1/incidents/${encodeURIComponent(id)}`);
    state.currentIncidentId = id;
    $("#incident-id").value = id;
    renderEvidence(data);
    logEvent("Incident inspected", `${id.slice(0, 12)}…`, "LOADED");
  } catch (error) {
    toast(formatError(error), true);
  } finally {
    $("#lookup").disabled = false;
  }
}

function renderEvidence(data) {
  const incident = data.incident ?? {};
  const assignments = data.assignments ?? [];
  const decision = data.decision;
  const optimizer = decision?.optimizerEvidence;
  const first = assignments[0];
  const summary = document.createElement("div");
  summary.className = "incident-summary";
  summary.innerHTML = `<div class="summary-top"><strong>${escapeText(incident.incidentId ?? "Incident")}</strong><span>${escapeText(incident.status ?? "UNKNOWN")}</span></div>
    <div class="summary-grid"><div><small>Priority</small><b>${escapeText(incident.priority ?? "—")}</b></div>
    <div><small>Assignments</small><b>${assignments.length}</b></div>
    <div><small>Resource epoch</small><b>${first?.resourceEpoch ?? "—"}</b></div>
    <div><small>Decision mode</small><b>${escapeText(decision?.mode ?? "Load decision separately")}</b></div>
    <div><small>Optimizer</small><b>${escapeText(optimizer?.algorithm ?? (optimizer?.fallbackReason ? "SAFE FALLBACK" : "LOCAL AUTHORITY"))}</b></div>
    <div><small>Solver proof</small><b>${optimizer?.algorithm
      ? `${optimizer.optimal ? "OPTIMAL" : "INCUMBENT"} · ${escapeText(String(optimizer.durationMs ?? "—"))} ms`
      : escapeText(optimizer?.fallbackReason ?? "DETERMINISTIC")}</b></div>
    <div><small>Policy</small><b>${escapeText(decision?.policyVersion ?? incident.metadata?.policyVersion ?? "—")}</b></div>
    <div><small>Route evidence</small><b>${escapeText(decision?.candidates?.[0]?.routeSource ?? "—")}</b></div></div>`;
  $("#incident-summary").replaceWith(summary);
  summary.id = "incident-summary";
  $("#raw-result").textContent = JSON.stringify(data, null, 2);
}

function logEvent(title, detail, outcome = "OK", error = false) {
  const list = $("#activity-log");
  $(".empty", list)?.remove();
  const item = document.createElement("li");
  if (error) item.className = "error";
  item.innerHTML = `<time>${new Date().toLocaleTimeString("en-GB", { hour12: false })}</time><span>${escapeText(title)} · ${escapeText(detail)}</span><b>${escapeText(outcome)}</b>`;
  list.prepend(item);
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3_500);
}

function requireConnection() {
  if (!state.connected || !state.token) throw new ApiError("Connect the secure API link first", 401, "NOT_CONNECTED");
}

function setScenarioBusy(busy) {
  state.busy = busy;
  $$("[data-action], #prepare").forEach((button) => { button.disabled = busy; });
}

function formatError(error) { return error?.code ? `${error.code}: ${error.message}` : error?.message ?? String(error); }
function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}
function spatialCell(location) {
  return `${location.regionId}:${Math.floor((location.latitude + 90) * 100)}:${Math.floor((location.longitude + 180) * 100)}`;
}
function escapeText(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

$("#connect").addEventListener("click", connect);
$("#token").addEventListener("keydown", (event) => { if (event.key === "Enter") connect(); });
$("#prepare").addEventListener("click", async () => {
  setScenarioBusy(true);
  try { await prepareBaseline(); } catch (error) { toast(formatError(error), true); } finally { setScenarioBusy(false); }
});
$(".scenario-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) runScenario(button.dataset.action);
});
$("#clear-log").addEventListener("click", () => { $("#activity-log").innerHTML = '<li class="empty">Timeline cleared.</li>'; });
$("#refresh").addEventListener("click", () => refreshSnapshot());
$("#lookup").addEventListener("click", () => inspectIncident());
$("#incident-id").addEventListener("keydown", (event) => { if (event.key === "Enter") inspectIncident(); });
$("#incident-table").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-incident-id]");
  if (row) inspectIncident(row.dataset.incidentId);
});
$("#flush-outbox").addEventListener("click", flushRetainedEvents);
$("#menu-button").addEventListener("click", () => {
  const open = $(".rail").classList.toggle("open");
  $("#menu-button").setAttribute("aria-expanded", String(open));
});
$$('.rail nav a').forEach((link) => link.addEventListener("click", () => $(".rail").classList.remove("open")));

const sections = ["overview", "response-lab", "incidents", "evidence", "infrastructure"]
  .map((id) => document.getElementById(id)).filter(Boolean);
const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  $$(".rail nav a").forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`));
}, { rootMargin: "-20% 0px -65%", threshold: [0, .25, .5] });
sections.forEach((section) => observer.observe(section));

refreshHealth();
if (state.token) connect();
setInterval(() => { if (!document.hidden) refreshHealth(); }, 10_000);
setInterval(() => { if (!document.hidden) refreshSnapshot({ silent: true }); }, 12_000);
setInterval(() => { if (!document.hidden) refreshTopology({ silent: true }); }, 5_000);

const health = document.querySelector("#health");
const result = document.querySelector("#result");
const simResult = document.querySelector("#sim-result");
const clock = document.querySelector("#clock");

// ─── Live Clock ──────────────────────────────────────
function updateClock() {
  clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}
updateClock();
setInterval(updateClock, 1000);

// ─── Health Monitoring ───────────────────────────────
async function refreshHealth() {
  try {
    const response = await fetch("/health/ready");
    const body = await response.json();
    health.textContent = `${body.regionId} · ${body.status}`;
    health.className = body.auditIntegrity ? "badge healthy" : "badge danger";
    document.querySelector("#kpi-status").textContent = body.status;
    document.querySelector("#kpi-audit").textContent = body.auditIntegrity ? "✓ Valid" : "✗ Broken";
    document.querySelector("#kpi-audit").style.color = body.auditIntegrity ? "#10b981" : "#ef4444";
  } catch {
    health.textContent = "System unavailable";
    health.className = "badge danger";
    document.querySelector("#kpi-status").textContent = "OFFLINE";
  }
}

// ─── Metrics Polling ─────────────────────────────────
async function refreshMetrics() {
  try {
    const response = await fetch("/metrics");
    const text = await response.text();
    let totalRequests = 0;
    let totalDecisions = 0;
    for (const line of text.split("\n")) {
      const reqMatch = line.match(/^http_requests_total\{.*?\}\s+(\d+)/);
      if (reqMatch) totalRequests += Number(reqMatch[1]);
      const decMatch = line.match(/^decision_total\{.*?\}\s+(\d+)/);
      if (decMatch) totalDecisions += Number(decMatch[1]);
    }
    document.querySelector("#kpi-requests").textContent = totalRequests.toLocaleString();
    document.querySelector("#kpi-decisions").textContent = totalDecisions.toLocaleString();
  } catch { /* metrics endpoint unavailable */ }
}

refreshHealth();
refreshMetrics();
setInterval(refreshHealth, 5_000);
setInterval(refreshMetrics, 5_000);

// ─── API Helpers ─────────────────────────────────────
function getToken() { return document.querySelector("#token").value; }
function headers() { return { authorization: `Bearer ${getToken()}`, "content-type": "application/json" }; }

async function apiPost(path, body) {
  const response = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  return response.json();
}

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function meta(overrides = {}) {
  const t = now();
  return {
    eventId: uuid(), correlationId: uuid(), idempotencyKey: `sim-${uuid()}`,
    schemaVersion: 1, aggregateVersion: 1, policyVersion: "policy-1", mapVersion: "map-1",
    resourceEpoch: 0, shardEpoch: 1, sourceTime: t, effectiveTime: t,
    authority: "regional-eoc", traceId: uuid(), ...overrides,
  };
}

function showSimResult(data) {
  simResult.textContent = JSON.stringify(data, null, 2);
}

// ─── Incident Lookup ─────────────────────────────────
document.querySelector("#lookup").addEventListener("click", async () => {
  const id = document.querySelector("#incident").value.trim();
  if (!id) return;
  result.textContent = "Loading…";
  try {
    const response = await fetch(`/v1/incidents/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${getToken()}` } });
    const data = await response.json();
    result.textContent = JSON.stringify(data, null, 2);
    // Auto-refresh KPIs after lookup
    refreshMetrics();
  } catch (error) {
    result.textContent = String(error);
  }
});

// ─── Simulation: Report P0 Incident ──────────────────
document.querySelector("#sim-incident").addEventListener("click", async () => {
  simResult.textContent = "Reporting P0 incident…";
  try {
    const data = await apiPost("/v1/incidents", {
      metadata: meta(),
      location: { latitude: 22.47, longitude: 91.78, regionId: "region-a" },
      severity: 9, affectedPeople: 1, timeToHarmMinutes: 5,
      requiredCapabilities: ["ALS"], requiredCapacity: 1,
      hazards: [], confidence: 0.95,
      responseDeadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      autoAllocate: true,
    });
    showSimResult(data);
    if (data.incident?.incidentId) {
      document.querySelector("#incident").value = data.incident.incidentId;
    }
    refreshMetrics();
  } catch (error) { simResult.textContent = `Error: ${error.message}`; }
});

// ─── Simulation: Register Ambulance ──────────────────
document.querySelector("#sim-resource").addEventListener("click", async () => {
  simResult.textContent = "Registering ambulance…";
  const id = `ambulance-${Date.now().toString(36)}`;
  try {
    const data = await apiPost("/v1/resources/telemetry", {
      resourceId: id, metadata: meta({ sourceSequence: 1 }),
      location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
      resourceType: "AMBULANCE", capabilities: ["ALS"], capacity: 1,
      status: "AVAILABLE", healthy: true, maintenance: false,
      sourceSequence: 1, jurisdiction: "region-a", crewAvailable: true,
      transportMode: "GROUND",
    });
    showSimResult({ resourceId: id, ...data });
    refreshMetrics();
  } catch (error) { simResult.textContent = `Error: ${error.message}`; }
});

// ─── Simulation: Register Helicopter ─────────────────
document.querySelector("#sim-helicopter").addEventListener("click", async () => {
  simResult.textContent = "Registering helicopter…";
  const id = `heli-${Date.now().toString(36)}`;
  try {
    const data = await apiPost("/v1/resources/telemetry", {
      resourceId: id, metadata: meta({ sourceSequence: 1 }),
      location: { latitude: 22.50, longitude: 91.81, regionId: "region-a" },
      resourceType: "HELICOPTER", capabilities: ["ALS"], capacity: 2,
      status: "AVAILABLE", healthy: true, maintenance: false,
      sourceSequence: 1, jurisdiction: "region-a", crewAvailable: true,
      transportMode: "AIR", hazardTolerances: ["HAZARD_FLOOD", "HAZARD_ROAD_COLLAPSE"],
    });
    showSimResult({ resourceId: id, ...data });
    refreshMetrics();
  } catch (error) { simResult.textContent = `Error: ${error.message}`; }
});

// ─── Simulation: Road Closure ────────────────────────
document.querySelector("#sim-closure").addEventListener("click", async () => {
  simResult.textContent = "Triggering road closure…";
  try {
    const data = await apiPost("/v1/environment", {
      eventId: `closure-${uuid()}`, regionId: "region-a", eventType: "ROAD_CLOSURE",
      payload: { description: "Bridge collapse — all ground routes blocked" },
      mapVersion: `map-${Date.now()}`,
      effectiveAt: now(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      closedCells: ["region-a:11247:27179", "region-a:11248:27179"],
    });
    showSimResult({ event: "ROAD_CLOSURE", ...data });
    refreshMetrics();
  } catch (error) { simResult.textContent = `Error: ${error.message}`; }
});

// ─── Simulation: Hospital Capacity ───────────────────
document.querySelector("#sim-hospital").addEventListener("click", async () => {
  simResult.textContent = "Setting hospital capacity…";
  try {
    const data = await apiPost("/v1/facilities/capacity", {
      facilityId: "hospital-regional-1", capability: "HOSPITAL_CARE", regionId: "region-a",
      available: 10, reserved: 2, sourceSequence: Date.now(),
      latitude: 22.46, longitude: 91.77, name: "Regional Medical Center",
    });
    showSimResult({ facilityId: "hospital-regional-1", ...data });
    refreshMetrics();
  } catch (error) { simResult.textContent = `Error: ${error.message}`; }
});

// ─── Simulation: Mass-Casualty Event ─────────────────
document.querySelector("#sim-mass").addEventListener("click", async () => {
  simResult.textContent = "Triggering mass-casualty event…";
  try {
    const data = await apiPost("/v1/incidents", {
      metadata: meta(),
      location: { latitude: 22.47, longitude: 91.78, regionId: "region-a" },
      severity: 10, affectedPeople: 50, timeToHarmMinutes: 3,
      requiredCapabilities: ["ALS"], requiredCapacity: 5,
      hazards: [], vulnerableGroups: ["children", "elderly"],
      environmentalEscalation: 0.8,
      confidence: 0.9,
      responseDeadline: new Date(Date.now() + 20 * 60_000).toISOString(),
      autoAllocate: true,
    });
    showSimResult(data);
    if (data.incident?.incidentId) {
      document.querySelector("#incident").value = data.incident.incidentId;
    }
    refreshMetrics();
  } catch (error) { simResult.textContent = `Error: ${error.message}`; }
});

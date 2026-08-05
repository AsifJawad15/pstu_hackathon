import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const port = String(20_000 + Math.floor(Math.random() * 20_000));
const databasePath = join(tmpdir(), `emergency-evaluator-${process.pid}-${Date.now()}.db`);
const token = randomBytes(32).toString("hex");
const environment = {
  ...process.env, HOST: "127.0.0.1", PORT: port, REGION_ID: "region-a", DATABASE_PATH: databasePath,
  EMERGENCY_API_TOKEN: token, COMMAND_SIGNING_KEY: randomBytes(32).toString("hex"), AUTO_ALLOCATE: "true",
};
const server = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
let serverError = "";
server.stderr.on("data", (chunk) => { serverError += String(chunk); });

try {
  await waitUntilReady(`http://127.0.0.1:${port}/health/live`, server);
  const evaluator = spawn(process.execPath, ["evaluation/black-box.mjs"], {
    cwd: process.cwd(), env: { ...environment, EVALUATOR_BASE_URL: `http://127.0.0.1:${port}`, EVALUATOR_API_TOKEN: token },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    evaluator.once("error", reject);
    evaluator.once("exit", (value) => resolve(value ?? 1));
  });
  process.exitCode = code;
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await Promise.all([databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map((path) => rm(path, { force: true })));
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Evaluator server exited early: ${serverError.trim()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Evaluator server did not become ready: ${serverError.trim()}`);
}

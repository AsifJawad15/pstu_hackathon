import { EmergencyApplication } from "./application.ts";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./http.ts";

const config = loadConfig();
const app = new EmergencyApplication(config);
const server = createHttpServer(app);

server.on("error", (error: NodeJS.ErrnoException) => {
  const hint = error.code === "EACCES"
    ? `Port ${config.port} is denied by the operating system; choose another PORT in .env (for example 8181).`
    : error.code === "EADDRINUSE"
      ? `Port ${config.port} is already in use; stop its current process or choose another PORT in .env.`
      : "Check the configured HOST and PORT.";
  process.stderr.write(JSON.stringify({
    level: "error", event: "server_start_failed", code: error.code, message: error.message, hint,
  }) + "\n");
  app.close();
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  process.stdout.write(JSON.stringify({
    level: "info", event: "server_started", regionId: config.regionId,
    address: `http://${config.host}:${config.port}`,
    securityWarning: config.apiToken === "development-only-token" ? "development_token_in_use" : undefined,
  }) + "\n");
});

function shutdown(signal: string): void {
  process.stdout.write(JSON.stringify({ level: "info", event: "server_stopping", signal }) + "\n");
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

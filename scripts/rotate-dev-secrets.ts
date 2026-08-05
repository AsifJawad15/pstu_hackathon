import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = ".env";
const template = existsSync(path) ? readFileSync(path, "utf8") : readFileSync(".env.example", "utf8");
const missingOnly = process.argv.includes("--missing-only");
const secret = () => randomBytes(32).toString("hex");
const replacements: Record<string, string> = {
  EMERGENCY_API_TOKEN: secret(),
  COMMAND_SIGNING_KEY: secret(),
  EDGE_SPOOL_KEY_HEX: secret(),
  POSTGRES_PASSWORD: secret(),
  GRAFANA_ADMIN_PASSWORD: secret(),
  OPTIMIZER_SHARED_SECRET: secret(),
};

let content = template;
const changed: string[] = [];
for (const [key, value] of Object.entries(replacements)) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  const current = match?.[1]?.trim();
  if (missingOnly && current && !current.startsWith("replace-with-")) continue;
  const line = `${key}=${value}`;
  content = new RegExp(`^${key}=.*$`, "m").test(content)
    ? content.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${content.trimEnd()}\n${line}\n`;
  changed.push(key);
}
writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
process.stdout.write(changed.length > 0
  ? `${missingOnly ? "Generated missing" : "Rotated"} development secrets: ${changed.join(", ")}.\n`
  : "All required development secrets are already configured.\n");

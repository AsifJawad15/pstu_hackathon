import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = ".env";
const template = existsSync(path) ? readFileSync(path, "utf8") : readFileSync(".env.example", "utf8");
const secret = () => randomBytes(32).toString("hex");
const replacements: Record<string, string> = {
  EMERGENCY_API_TOKEN: secret(),
  COMMAND_SIGNING_KEY: secret(),
  EDGE_SPOOL_KEY_HEX: secret(),
};

let content = template;
for (const [key, value] of Object.entries(replacements)) {
  const line = `${key}=${value}`;
  content = new RegExp(`^${key}=.*$`, "m").test(content)
    ? content.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${content.trimEnd()}\n${line}\n`;
}
writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
process.stdout.write("Rotated local API, command-signing, and edge-spool secrets in .env.\n");


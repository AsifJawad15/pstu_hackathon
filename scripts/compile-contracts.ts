import { mkdirSync, writeFileSync } from "node:fs";
import protobuf from "protobufjs";

const root = await protobuf.load("contracts/emergency.proto");
root.resolveAll();
for (const requiredType of [
  "emergency.v1.EventMetadata",
  "emergency.v1.ReportIncidentRequest",
  "emergency.v1.ResourceTelemetry",
  "emergency.v1.DispatchCommand",
  "emergency.v1.DispatchAcknowledgement",
  "emergency.v1.EmergencyPlatform",
]) {
  root.lookup(requiredType);
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/emergency-descriptor.json", JSON.stringify(root.toJSON(), null, 2));
process.stdout.write("Validated contracts/emergency.proto\n");

import { createHmac, timingSafeEqual } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export class CommandSigner {
  readonly #key: string;

  constructor(key: string) {
    if (key.length < 32) throw new Error("Command signing key must contain at least 32 characters");
    this.#key = key;
  }

  sign(command: Omit<Record<string, unknown>, "signature">): string {
    return createHmac("sha256", this.#key).update(canonicalJson(command)).digest("base64url");
  }

  verify(command: Record<string, unknown> & { signature: string }): boolean {
    const { signature, ...unsigned } = command;
    const expected = Buffer.from(this.sign(unsigned));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}

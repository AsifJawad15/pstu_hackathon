import { appendFileSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class EncryptedEdgeSpool {
  readonly #key: Buffer;
  readonly #path: string;

  constructor(path: string, keyHex: string) {
    this.#path = path;
    this.#key = Buffer.from(keyHex, "hex");
    if (this.#key.length !== 32) throw new Error("Edge spool key must be exactly 32 bytes");
    mkdirSync(dirname(path), { recursive: true });
  }

  append(payload: unknown): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const record = {
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    appendFileSync(this.#path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  drain(): unknown[] {
    let content: string;
    try { content = readFileSync(this.#path, "utf8"); } catch { return []; }
    const values = content.split(/\r?\n/).filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { nonce: string; tag: string; ciphertext: string };
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(record.nonce, "base64"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final(),
      ]).toString("utf8"));
    });
    truncateSync(this.#path, 0);
    return values;
  }
}

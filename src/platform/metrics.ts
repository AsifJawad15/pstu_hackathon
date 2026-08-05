export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #durations = new Map<string, number[]>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.#key(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + value);
  }

  observe(name: string, milliseconds: number, labels: Record<string, string> = {}): void {
    const key = this.#key(name, labels);
    const values = this.#durations.get(key) ?? [];
    values.push(milliseconds);
    if (values.length > 10_000) values.shift();
    this.#durations.set(key, values);
  }

  percentile(name: string, percentile: number): number | undefined {
    const entries = [...this.#durations.entries()].filter(([key]) => key.startsWith(`${name}{`));
    const values = entries.flatMap(([, samples]) => samples).sort((a, b) => a - b);
    if (values.length === 0) return undefined;
    return values[Math.min(values.length - 1, Math.ceil(values.length * percentile) - 1)];
  }

  prometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.#counters) lines.push(`${key} ${value}`);
    for (const [key, values] of this.#durations) {
      const base = key.replace(/\{/, "_milliseconds{");
      lines.push(`${base.replace("{", "_count{")} ${values.length}`);
      lines.push(`${base.replace("{", "_sum{")} ${values.reduce((sum, value) => sum + value, 0)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  #key(name: string, labels: Record<string, string>): string {
    const encoded = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}="${value.replaceAll('"', '\\"')}"`).join(",");
    return `${name}{${encoded}}`;
  }
}


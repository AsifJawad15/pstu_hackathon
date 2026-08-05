import type { Priority } from "../domain/types.ts";

export class AdmissionController {
  readonly #active = new Map<Priority, number>([["P0", 0], ["P1", 0], ["P2", 0], ["P3", 0]]);
  readonly #p0Capacity: number;
  readonly #generalCapacity: number;

  constructor(p0Capacity: number, generalCapacity: number) {
    this.#p0Capacity = p0Capacity;
    this.#generalCapacity = generalCapacity;
  }

  enter(priority: Priority): () => void {
    const current = this.#active.get(priority) ?? 0;
    const totalGeneral = (this.#active.get("P1") ?? 0) + (this.#active.get("P2") ?? 0) + (this.#active.get("P3") ?? 0);
    if (priority === "P0" ? current >= this.#p0Capacity : totalGeneral >= this.#generalCapacity) {
      const error = new Error("Admission capacity exhausted");
      Object.assign(error, { code: "ADMISSION_OVERLOADED", status: 503 });
      throw error;
    }
    this.#active.set(priority, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.set(priority, Math.max(0, (this.#active.get(priority) ?? 1) - 1));
    };
  }

  snapshot(): Record<Priority, number> {
    return Object.fromEntries(this.#active) as Record<Priority, number>;
  }
}

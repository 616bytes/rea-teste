import { availableParallelism } from "node:os";

/** Releases one admitted run's slot; later calls do nothing. */
export type KunaRunRelease = () => void;

/**
 * Provider-wide admission for foreground decompile and reference walks.
 *
 * Each run analyzes the whole image again in its own process tree, which held
 * about 360 MiB resident and close to one core on a 200 KiB Mach-O. These runs only
 * share the cores reserved beyond a project export's `--jobs` workers.
 * Requests beyond that budget wait in FIFO order. A native cleanup owner
 * keeps its slot while it cannot prove that the process stopped.
 */
export class KunaRunSlots {
  readonly #capacity: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  /** Slots for the cores an export with `jobs` workers leaves on this host. */
  static forHost(jobs: number): KunaRunSlots {
    return new KunaRunSlots(availableParallelism() - jobs);
  }

  /** Wait for a slot; undefined when the signal aborts first. */
  acquire(signal: AbortSignal): Promise<KunaRunRelease | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.#active < this.#capacity) {
      this.#active += 1;
      return Promise.resolve(this.#release());
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        this.#active += 1;
        resolve(this.#release());
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(grant);
        if (index !== -1) this.#waiting.splice(index, 1);
        resolve(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(grant);
    });
  }

  #release(): KunaRunRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiting.shift()?.();
    };
  }
}

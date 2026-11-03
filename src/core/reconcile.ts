/** Shared change/deadline scheduling; each registration runs independently. */
export type CheckRegistration = {
  noticeChange(): void;
  requestCheck(): void;
  schedule(at: number | undefined): void;
  dispose(): void;
};

export class Reconciler {
  private readonly registrations = new Set<CheckRegistration>();
  private disposed = false;

  constructor(private readonly log: (line: string) => void = () => {}) {}

  register(name: string, changeDelay: number, check: () => Promise<void>): CheckRegistration {
    let disposed = this.disposed;
    let nudge: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let running = false;
    let again = false;
    const run = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await check();
        } while (again && !disposed);
      } catch (err) {
        this.log(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        again = false;
        running = false;
      }
    };
    const registration: CheckRegistration = {
      noticeChange: () => {
        if (disposed || nudge !== undefined) {
          return;
        }
        // Coalesce from the first frame: postponing on every frame would starve
        // the check throughout a streaming turn.
        nudge = setTimeout(() => {
          nudge = undefined;
          registration.requestCheck();
        }, changeDelay);
      },
      requestCheck: () => {
        void run();
      },
      schedule: (at) => {
        if (disposed) {
          return;
        }
        clearTimeout(deadline);
        deadline = undefined;
        if (at !== undefined) {
          deadline = setTimeout(
            () => {
              deadline = undefined;
              registration.requestCheck();
            },
            // Insurance against clock jumps or a past deadline, rather than
            // domain policy: an explicitly rearmed deadline cannot spin.
            Math.max(1_000, at - Date.now())
          );
        }
      },
      dispose: () => {
        disposed = true;
        clearTimeout(nudge);
        nudge = undefined;
        clearTimeout(deadline);
        deadline = undefined;
        this.registrations.delete(registration);
      }
    };
    if (!this.disposed) {
      this.registrations.add(registration);
    }
    return registration;
  }

  dispose(): void {
    this.disposed = true;
    for (const registration of this.registrations) {
      registration.dispose();
    }
  }
}

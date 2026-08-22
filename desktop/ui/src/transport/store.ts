import type {
  CommandPlacementTag,
  UiKernelSnapshot,
  UiKernelTransport,
  Unsubscribe,
} from "./types";

export type UiStoreSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly source: UiKernelTransport["source"];
      readonly snapshot: UiKernelSnapshot;
    };

const LOADING: UiStoreSnapshot = Object.freeze({ status: "loading" });

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 512);
  return "Rho could not load the UI Kernel snapshot.";
}

function deepFreeze<T>(value: T): T {
  if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sameSnapshot(left: UiKernelSnapshot, right: UiKernelSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class UiExternalStore {
  readonly #transport: UiKernelTransport;
  readonly #listeners = new Set<() => void>();
  #state: UiStoreSnapshot = LOADING;
  #stopTransport: Unsubscribe | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(transport: UiKernelTransport) {
    this.#transport = transport;
  }

  readonly getSnapshot = (): UiStoreSnapshot => this.#state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stopTransport = this.#transport.subscribeInvalidated(() => {
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopTransport?.();
        this.#stopTransport = undefined;
      }
    };
  };

  #publish(state: UiStoreSnapshot): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #install(snapshot: UiKernelSnapshot): void {
    const current = this.#state;
    if (current.status === "ready") {
      const currentRevision = current.snapshot.snapshot_revision;
      if (snapshot.snapshot_revision < currentRevision) return;
      if (snapshot.snapshot_revision === currentRevision) {
        if (sameSnapshot(snapshot, current.snapshot)) return;
        this.#publish({
          status: "failed",
          message: "UI Kernel returned different data for one snapshot revision.",
        });
        return;
      }
    }
    this.#publish(
      deepFreeze({ status: "ready", source: this.#transport.source, snapshot } as const),
    );
  }

  async #runRefreshLoop(): Promise<void> {
    do {
      this.#refreshQueued = false;
      try {
        this.#install(await this.#transport.loadSnapshot());
      } catch (error: unknown) {
        if (this.#state.status !== "ready") {
          this.#publish({ status: "failed", message: errorMessage(error) });
        }
      }
    } while (this.#refreshQueued);
  }

  refresh(): Promise<void> {
    if (this.#refreshing != null) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = this.#runRefreshLoop().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }
}

export function commandsForPlacement(
  snapshot: UiKernelSnapshot,
  placement: CommandPlacementTag,
) {
  return snapshot.command_registry.registrations.filter((registration) =>
    registration.definition.placement_tags.includes(placement),
  );
}

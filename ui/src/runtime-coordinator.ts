import { Model } from "./shared/model";
import { message } from "./shared/ports";
import type { QueryPort } from "./shared/ports";
import type { QuerySnapshot } from "./generated/QuerySnapshot";

interface Task {
  interval: number;
  run: () => Promise<void | boolean>;
  due: number;
  inFlight: boolean;
  failures: number;
  error: string;
}
export interface TaskState { readonly inFlight: boolean; readonly error: string; readonly failures: number }
const backoff = [500, 1000, 2000, 5000];

/** One clock, independent fault domains, and one serialized native observation lane. */
export class RuntimeCoordinator extends Model<{ tasks: Readonly<Record<string, TaskState>> }> {
  private tasks = new Map<string, Task>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private acceptingReads = true;
  private generation = 0;
  private reads = new Map<string, Promise<QuerySnapshot>>();
  private tail: Promise<unknown> = Promise.resolve();
  protected readSnapshot() {
    return { tasks: Object.freeze(Object.fromEntries([...this.tasks].map(([id, t]) =>
      [id, Object.freeze({ inFlight: t.inFlight, error: t.error, failures: t.failures })]))) };
  }
  register(id: string, interval: number, run: Task["run"]) {
    if (this.tasks.has(id)) throw new Error(`Duplicate runtime task: ${id}`);
    this.tasks.set(id, { interval, run, due: 0, inFlight: false, failures: 0, error: "" });
  }
  startReads() { this.acceptingReads = true; }
  start() { this.startReads(); this.stopped = false; this.wake(); }
  wake(id?: string) {
    for (const [name, task] of this.tasks) if ((!id || id === name) && !task.failures) task.due = 0;
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 0);
  }
  private tick() {
    if (this.stopped) return;
    const generation = this.generation;
    for (const task of this.tasks.values()) {
      if (task.inFlight || Date.now() < task.due) continue;
      const startedAt = Date.now();
      task.inFlight = true;
      void Promise.resolve().then(() => {
        if (this.stopped || generation !== this.generation) return;
        return task.run();
      }).then((backlog) => {
        if (generation !== this.generation) return;
        task.error = "";
        task.failures = 0;
        task.due = backlog ? 0 : startedAt + task.interval;
      }, (error: unknown) => {
        if (generation !== this.generation) return;
        task.error = message(error);
        task.failures++;
        task.due = Date.now() + backoff[Math.min(task.failures - 1, backoff.length - 1)];
      }).finally(() => {
        if (generation !== this.generation) return;
        task.inFlight = false;
        this.publish();
      });
    }
    this.timer = setTimeout(() => this.tick(), 250);
  }
  /** Duplicate resource demands share a promise. Native reads never overlap. */
  query(read: QueryPort): QueryPort {
    return (project, id, args = {}) => {
      if (!this.acceptingReads) return Promise.reject(new Error("Client stopped reading"));
      if (!new Set(["workspace.snapshot", "workspace.inspect_object", "workspace.list_objects", "workspace.observe_object", "workspace.read_object", "workspace.package_index", "workspace.packages", "workspace.check_code", "workspace.help"]).has(id))
        return read(project, id, args);
      const key = JSON.stringify([this.generation, project, id, args]);
      const existing = this.reads.get(key);
      if (existing) return existing;
      const generation = this.generation;
      const task = this.tail.catch(() => {}).then(() => {
        if (!this.acceptingReads || generation !== this.generation) throw new Error("Observation cancelled after client lifecycle changed");
        return read(project, id, args);
      });
      this.tail = task;
      this.reads.set(key, task);
      void task.finally(() => {
        if (this.reads.get(key) === task) this.reads.delete(key);
      }).catch(() => {});
      return task;
    };
  }
  stop() {
    this.stopped = true;
    this.acceptingReads = false;
    this.generation++;
    clearTimeout(this.timer);
    this.reads.clear();
    // Active read cancellation belongs to the transport; its old cleanup cannot touch the new lane.
    for (const task of this.tasks.values()) {
      task.inFlight = false; task.due = 0; task.error = ""; task.failures = 0;
    }
    this.publish();
  }
}

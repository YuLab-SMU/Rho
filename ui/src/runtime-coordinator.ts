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

/** One clock and a separate serialized native observation lane per project/instance. */
export class RuntimeCoordinator extends Model<{ tasks: Readonly<Record<string, TaskState>> }> {
  private tasks = new Map<string, Task>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private acceptingReads = true;
  private generation = 0;
  private reads = new Map<string, Promise<QuerySnapshot>>();
  private tails = new Map<string, Promise<unknown>>();
  protected readSnapshot() {
    return { tasks: Object.freeze(Object.fromEntries([...this.tasks].map(([id, t]) =>
      [id, Object.freeze({ inFlight: t.inFlight, error: t.error, failures: t.failures })]))) };
  }
  register(id: string, interval: number, run: Task["run"]) {
    if (this.tasks.has(id)) throw new Error(`Duplicate runtime task: ${id}`);
    this.tasks.set(id, { interval, run, due: 0, inFlight: false, failures: 0, error: "" });
  }
  unregister(id: string) { this.tasks.delete(id); this.publish(); }
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
        if (this.stopped || generation !== this.generation || ![...this.tasks.values()].includes(task)) return;
        return task.run();
      }).then((backlog) => {
        if (generation !== this.generation || ![...this.tasks.values()].includes(task)) return;
        task.error = "";
        task.failures = 0;
        task.due = backlog ? 0 : startedAt + task.interval;
      }, (error: unknown) => {
        if (generation !== this.generation || ![...this.tasks.values()].includes(task)) return;
        task.error = message(error);
        task.failures++;
        task.due = Date.now() + backoff[Math.min(task.failures - 1, backoff.length - 1)];
      }).finally(() => {
        if (generation !== this.generation || ![...this.tasks.values()].includes(task)) return;
        task.inFlight = false;
        this.publish();
      });
    }
    this.timer = setTimeout(() => this.tick(), 250);
  }
  /** Duplicate demands coalesce; another R instance never waits for this instance's read. */
  query(read: QueryPort): QueryPort {
    return (project, id, args = {}) => {
      if (!this.acceptingReads) return Promise.reject(new Error("Client stopped reading"));
      if (!new Set(["workspace.snapshot", "workspace.inspect_object", "workspace.list_objects", "workspace.observe_object", "workspace.read_object", "workspace.package_index", "workspace.packages", "workspace.check_code", "workspace.help"]).has(id))
        return read(project, id, args);
      const key = JSON.stringify([this.generation, project, id, args]);
      const existing = this.reads.get(key);
      if (existing) return existing;
      const generation = this.generation;
      const instanceId = args && typeof args === "object" && !Array.isArray(args) ? (args as { workspace_instance_id?: string }).workspace_instance_id : undefined;
      const lane = JSON.stringify([project, instanceId ?? "main"]);
      const task = (this.tails.get(lane) ?? Promise.resolve()).catch(() => {}).then(() => {
        if (!this.acceptingReads || generation !== this.generation) throw new Error("Observation cancelled after client lifecycle changed");
        return read(project, id, args);
      });
      this.tails.set(lane, task);
      this.reads.set(key, task);
      void task.finally(() => {
        if (this.reads.get(key) === task) this.reads.delete(key);
        if (this.tails.get(lane) === task) this.tails.delete(lane);
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

/** UI subscriptions are batched separately from synchronous domain notifications. */
const pending = new Set<() => void>();
let scheduled = false;
function enqueue(listener: () => void) {
  pending.add(listener);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const batch = [...pending];
    pending.clear();
    for (const notify of batch) notify();
  });
}

export abstract class Model<S> {
  private cached: Readonly<S> | undefined;
  private listeners = new Set<() => void>();
  protected abstract readSnapshot(): S;
  getSnapshot = (): Readonly<S> =>
    (this.cached ??= Object.freeze(this.readSnapshot()));
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify = () => {
    for (const listener of [...this.listeners]) listener();
  };
  protected publish() {
    this.cached = undefined;
    enqueue(this.notify);
  }
  dispose() {
    this.listeners.clear();
    pending.delete(this.notify);
  }
}

/** Snapshot collections deliberately have no mutation methods, even at runtime. */
export function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source);
  const result: ReadonlyMap<K, V> = {
    size: map.size,
    get: (key) => map.get(key), has: (key) => map.has(key),
    entries: () => map.entries(), keys: () => map.keys(), values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach: (callback, thisArg) => map.forEach((value, key) => callback.call(thisArg, value, key, result)),
  };
  return Object.freeze(result);
}
export function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  const set = new Set(source);
  const result: ReadonlySet<T> = {
    size: set.size, has: (value) => set.has(value),
    entries: () => set.entries(), keys: () => set.keys(), values: () => set.values(),
    [Symbol.iterator]: () => set[Symbol.iterator](),
    forEach: (callback, thisArg) => set.forEach((value) => callback.call(thisArg, value, value, result)),
  };
  return Object.freeze(result);
}
export function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

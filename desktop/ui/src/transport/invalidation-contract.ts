export const INVALIDATION_EVENTS = {
  kernel: [
    "rho://ui-snapshot-invalidated",
    "rho://runtime-registry-changed",
    "project://files-changed",
    "rho://agent-turn-updated",
  ],
  surfaces: ["rho://surface-runtime-changed", "rho://ui-snapshot-invalidated"],
  "plugin-surfaces": [
    "rho://plugin-surface-changed",
    "rho://surface-runtime-changed",
    "rho://ui-snapshot-invalidated",
  ],
  "check-results": ["rho://check-results-changed", "rho://ui-snapshot-invalidated"],
  studio: [
    "rho://studio-runtime-changed",
    "rho://surface-runtime-changed",
    "rho://ui-snapshot-invalidated",
  ],
  profile: ["rho://ui-profile-changed", "rho://ui-snapshot-invalidated"],
  runtimes: ["rho://runtime-registry-changed", "rho://ui-snapshot-invalidated"],
  resources: ["rho://resource-registry-changed", "rho://ui-snapshot-invalidated"],
  agent: ["rho://agent-turn-updated", "rho://ui-snapshot-invalidated"],
} as const;

export type InvalidationTopic = keyof typeof INVALIDATION_EVENTS;

export const INVALIDATION_TOPICS = Object.freeze(
  Object.keys(INVALIDATION_EVENTS) as InvalidationTopic[],
);

export function invalidationEvents(topic: InvalidationTopic): readonly string[] {
  return INVALIDATION_EVENTS[topic];
}

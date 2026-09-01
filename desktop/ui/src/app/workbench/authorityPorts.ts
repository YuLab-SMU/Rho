import type { AuthorityReadTransport } from "../../transport/authority";
import type { EnvironmentReadTransport } from "../../transport/environment";
import type { KernelTransport } from "../../transport/kernel-generated";
import type { DomainSurfaceData } from "../../transport";
import type { Unsubscribe } from "../../transport/types";

export type AuthorityProjectPort = Pick<KernelTransport, "loadSnapshot">;

type EnvironmentFactsPort = Pick<
  EnvironmentReadTransport,
  | "environmentHealth"
  | "reobserveEnvironment"
>;

export type AuthorityEnvironmentPort = EnvironmentFactsPort & {
  loadDomainSurface(surfaceId: string): Promise<DomainSurfaceData>;
  subscribeInvalidated(listener: () => void): Unsubscribe;
};

export interface AuthorityPorts {
  readonly facts: AuthorityReadTransport;
  readonly project: AuthorityProjectPort;
  readonly environment: AuthorityEnvironmentPort;
}

type AuthorityPortSource = AuthorityReadTransport
  & KernelTransport
  & EnvironmentFactsPort
  & Pick<AuthorityEnvironmentPort, "loadDomainSurface" | "subscribeInvalidated">;

const cache = new WeakMap<object, AuthorityPorts>();

export function createAuthorityPorts(source: AuthorityPortSource): AuthorityPorts {
  const cached = cache.get(source as object);
  if (cached != null) return cached;
  const ports: AuthorityPorts = {
    facts: {
      resolveAuthorityRefs: (request) => source.resolveAuthorityRefs(request),
      listAuthorityReceipts: (request) => source.listAuthorityReceipts(request),
    },
    project: {
      loadSnapshot: () => source.loadSnapshot(),
    },
    environment: {
      environmentHealth: () => source.environmentHealth(),
      reobserveEnvironment: () => source.reobserveEnvironment(),
      loadDomainSurface: (surfaceId) => source.loadDomainSurface(surfaceId),
      subscribeInvalidated: (listener) => source.subscribeInvalidated(listener),
    },
  };
  cache.set(source as object, ports);
  return ports;
}

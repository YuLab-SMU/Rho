import { useEffect, useMemo, useState } from "react";

import type {
  AuthorityObservation,
  AuthorityReadTransport,
  AuthorityReference,
} from "../../transport/authority";

export function authorityReferenceKey(reference: AuthorityReference): string {
  return `${reference.kind}:${reference.authority_id}`;
}

export function useAuthorityProjection(
  transport: AuthorityReadTransport,
  references: readonly AuthorityReference[],
  reportError: (error: unknown) => void,
) {
  const signature = JSON.stringify(
    references
      .map((reference) => ({ ...reference }))
      .sort((left, right) => authorityReferenceKey(left).localeCompare(authorityReferenceKey(right))),
  );
  const uniqueReferences = useMemo(() => {
    const parsed = JSON.parse(signature) as AuthorityReference[];
    const byKey = new Map<string, AuthorityReference>();
    for (const reference of parsed) byKey.set(authorityReferenceKey(reference), reference);
    return [...byKey.values()];
  }, [signature]);
  const [observations, setObservations] = useState<ReadonlyMap<string, AuthorityObservation>>(
    () => new Map(),
  );
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let current = true;
    if (uniqueReferences.length === 0) {
      setObservations(new Map());
      setUnavailable(false);
      return () => { current = false; };
    }
    void transport.resolveAuthorityRefs({ references: uniqueReferences })
      .then((resolved) => {
        if (!current) return;
        setObservations(new Map(resolved.map((observation) => [
          authorityReferenceKey(observation.reference),
          observation,
        ])));
        setUnavailable(false);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setObservations(new Map());
        setUnavailable(true);
        reportError(error);
      });
    return () => { current = false; };
  }, [reportError, transport, uniqueReferences]);

  return { observations, unavailable };
}

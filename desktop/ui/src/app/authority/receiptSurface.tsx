import { useCallback } from "react";

import type {
  AuthorityKind,
  AuthorityReadTransport,
  AuthorityReceipt,
} from "../../transport/authority";
import { AuthorityList } from "./AuthorityList";
import { AuthorityStatus } from "./AuthorityStatus";

export function ReceiptSurface({ title, kind, empty, transport }: {
  readonly title: string;
  readonly kind: AuthorityKind;
  readonly empty: string;
  readonly transport: AuthorityReadTransport;
}) {
  const load = useCallback(async () => (await transport.listAuthorityReceipts({
    kind,
    cursor: null,
    limit: 200,
  })).items, [kind, transport]);
  return <AuthorityList<AuthorityReceipt>
    title={title}
    load={load}
    empty={empty}
    render={(receipt) => <article
      data-authority-status={receipt.status}
      key={receipt.reference.kind + ":" + receipt.reference.authority_id}
    >
      <strong>{receipt.label}</strong>
      <AuthorityStatus receipt={receipt} />
      <small>{receipt.captured_at}</small>
      {receipt.related_refs.length > 0 && <ul aria-label={"Related Authority refs for " + receipt.label}>
        {receipt.related_refs.map((reference) => <li key={reference.kind + ":" + reference.authority_id}>
          {reference.kind}: {reference.authority_id}
        </li>)}
      </ul>}
    </article>}
  />;
}

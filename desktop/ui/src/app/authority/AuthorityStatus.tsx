import type { AuthorityReceipt } from "../../transport/authority";

export function AuthorityStatus({ receipt }: { readonly receipt: AuthorityReceipt }) {
  return <div className={`rho-authority-status rho-authority-status-${receipt.status}`}>
    <span>authority: {receipt.status}</span>
    {receipt.digest != null && <code title={receipt.digest}>digest {receipt.digest.slice(0, 19)}…</code>}
  </div>;
}

import type { AuthorityReadTransport } from "../../transport/authority";
import { ReceiptSurface } from "./receiptSurface";

export function ApprovalsSurface({ transport }: { readonly transport: AuthorityReadTransport }) {
  return <ReceiptSurface
    title="Approvals"
    kind="approval"
    empty="No exact-effect Approval receipt is available."
    transport={transport}
  />;
}

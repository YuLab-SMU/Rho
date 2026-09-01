import type { AuthorityReadTransport } from "../../transport/authority";
import { ReceiptSurface } from "./receiptSurface";

export function RunsSurface({ transport }: { readonly transport: AuthorityReadTransport }) {
  return <ReceiptSurface
    title="Runs"
    kind="run"
    empty="No committed Run receipt is available from the execution Authority."
    transport={transport}
  />;
}

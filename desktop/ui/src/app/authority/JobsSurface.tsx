import type { AuthorityReadTransport } from "../../transport/authority";
import { ReceiptSurface } from "./receiptSurface";

export function JobsSurface({ transport }: { readonly transport: AuthorityReadTransport }) {
  return <ReceiptSurface
    title="Jobs"
    kind="job"
    empty="No Job Authority projection is currently published; Runs are not guessed to be Jobs."
    transport={transport}
  />;
}

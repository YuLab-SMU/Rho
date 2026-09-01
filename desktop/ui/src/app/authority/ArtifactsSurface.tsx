import type { AuthorityReadTransport } from "../../transport/authority";
import { ReceiptSurface } from "./receiptSurface";

export function ArtifactsSurface({ transport }: { readonly transport: AuthorityReadTransport }) {
  return <ReceiptSurface
    title="Artifacts"
    kind="artifact"
    empty="No Artifact receipt with canonical byte identity is available."
    transport={transport}
  />;
}

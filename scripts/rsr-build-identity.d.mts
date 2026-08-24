export interface RsrBuildIdentity {
  readonly id: string;
  readonly inputCount: number;
  readonly inputs: readonly string[];
}

export function buildIdentityInputs(root?: string): readonly string[];
export function computeBuildIdentity(root?: string): RsrBuildIdentity;
export const currentBuildIdentity: RsrBuildIdentity;

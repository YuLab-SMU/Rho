import {
  createCheckCommands,
  type FindingReferenceV1,
  type CheckFindingV1,
  type CheckInvoke,
  type CheckProjectSnapshotV1,
  type CheckResultRequest as CheckResultRequestWire,
  type CheckResultStatusV1,
  type CheckResultV1,
  type CheckRunRequest as CheckRunRequestWire,
  type CheckRunResponse as CheckRunResponseWire,
  type CheckSeverityV1,
} from "./generated/check";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type CheckSeverity = CheckSeverityV1;
export type CheckResultStatus = CheckResultStatusV1;
export type FindingReference = DeepReadonly<FindingReferenceV1>;
export type CheckFinding = DeepReadonly<CheckFindingV1>;
export type CheckRunRequest = DeepReadonly<CheckRunRequestWire>;
export type CheckResultRequest = DeepReadonly<CheckResultRequestWire>;

export type CheckProjectSnapshot = Omit<
  DeepReadonly<CheckProjectSnapshotV1>,
  "contract"
> & {
  readonly contract: "rho.ui.check-project.snapshot.v1";
};

export type CheckResult = Omit<
  DeepReadonly<CheckResultV1>,
  "contract" | "snapshot"
> & {
  readonly contract: "rho.ui.check-result.v1";
  readonly snapshot: CheckProjectSnapshot;
};

export type CheckRunResponse = Omit<
  DeepReadonly<CheckRunResponseWire>,
  "result"
> & {
  readonly result: CheckResult;
};

export interface CheckTransport {
  runCheckProject(request: CheckRunRequest): Promise<CheckRunResponse>;
  loadCheckResult(request: CheckResultRequest): Promise<CheckResult>;
}

function snapshotFromWire(snapshot: CheckProjectSnapshotV1): CheckProjectSnapshot {
  if (snapshot.contract !== "rho.ui.check-project.snapshot.v1") {
    throw new Error(`Unsupported Check snapshot contract: ${snapshot.contract}`);
  }
  return snapshot as CheckProjectSnapshot;
}

function resultFromWire(result: CheckResultV1): CheckResult {
  if (result.contract !== "rho.ui.check-result.v1") {
    throw new Error(`Unsupported Check result contract: ${result.contract}`);
  }
  return { ...result, snapshot: snapshotFromWire(result.snapshot) } as CheckResult;
}

export function createTauriCheckTransport(invoke: CheckInvoke): CheckTransport {
  const commands = createCheckCommands(invoke);
  return {
    runCheckProject: async (request) => ({
      result: resultFromWire((await commands.checkProjectRun(request)).result),
    }),
    loadCheckResult: async (request) => resultFromWire(
      await commands.checkResult(request),
    ),
  };
}

import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OperationRecord } from "../src/generated/OperationRecord";
import type { ComponentToolReceipt } from "../src/generated/ComponentToolReceipt";
const fixtures=vi.hoisted(()=>({records:new Map<string,OperationRecord>(),open:vi.fn(),read:vi.fn(async()=>null)}));
vi.mock("../src/context",()=>({
  useOperations:()=>({getRecord:(id:string)=>fixtures.records.get(id),ensureOperation:fixtures.read}),
  useOutputs:()=>({getSnapshot:()=>({media:[]})}),
  useNavigation:()=>({openOperation:fixtures.open}),
  useAgentTasks:()=>({historyVisible:true}),
  useRuntimeSessions:()=>({getInstance:()=>({name:"Main"})}),
}));
import { ScientificOperations, receiptOperationIds, scientificOperationLabel } from "../src/panels/agent-scientific-work";

it("uses original Operation state and ID links independently of the Agent response",async()=>{
  const record={operation:{operation_id:"original-operation",capability:{id:"workspace.run_r",version:1},normalized_arguments:{workspace_instance_id:"main"},target:{kind:"workspace",identity:"native-original"}},status:"accepted",error:null} as OperationRecord;
  fixtures.records.set("original-operation",record);
  const view=render(<ScientificOperations ids={["original-operation"]}/>);
  fireEvent.click(screen.getByText("Scientific work · 1 active"));
  fireEvent.click(screen.getByRole("button",{name:/Accepted/}));
  expect(fixtures.open).toHaveBeenCalledWith("original-operation"); expect(screen.getByText("R session · Main")).toBeTruthy();
  expect(scientificOperationLabel(undefined)).toBe("Unknown");
  fixtures.records.set("original-operation",{...record,status:"running"}); view.rerender(<ScientificOperations ids={["original-operation"]}/>);
  expect(screen.getByRole("button",{name:/Running/})).toBeTruthy();
  await waitFor(()=>expect(fixtures.read).toHaveBeenCalledWith("original-operation")); view.unmount(); fixtures.records.clear();
});
it("read-only evidence about old operations is not attributed as work produced by the Rho turn",()=>{
  const receipt=(mutation:boolean,operation_id:string|null,evidence:unknown[])=>({mutation,operation_id,evidence}) as ComponentToolReceipt;
  expect(receiptOperationIds([receipt(false,null,[{kind:"operation",operation_id:"read-source"}]),receipt(true,"produced",[{kind:"operation",operation_id:"produced"}]),receipt(true,null,[{kind:"operation",operation_id:"saved"}])])).toEqual(["produced","saved"]);
});

it("a fresh original-owner update clears an earlier failed read without a component polling loop",async()=>{
  const before={operation:{operation_id:"recovered",capability:{id:"workspace.run_r",version:1},normalized_arguments:{workspace_instance_id:"main"},target:{kind:"workspace",identity:"original"}},status:"running",error:null} as OperationRecord;
  fixtures.records.set("recovered",before); fixtures.read.mockRejectedValueOnce(new Error("Read unavailable"));
  const view=render(<ScientificOperations ids={["recovered"]}/>);
  await waitFor(()=>expect(screen.getByText("Scientific work · Status unavailable")).toBeTruthy());
  fixtures.records.set("recovered",{...before,status:"succeeded"}); view.rerender(<ScientificOperations ids={["recovered"]}/>);
  expect(screen.getByText("Scientific work · 1 observed")).toBeTruthy(); view.unmount(); fixtures.records.clear();
});

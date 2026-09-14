import { useEffect, useState } from "react";
import { useAgentTasks, useNavigation, useOperations, useOutputs, useRuntimeSessions } from "../context";
import { operationWorkspaceInstance, terminal } from "../shared/ports";
import type { AgentTaskSummary } from "../generated/AgentTaskSummary";
import type { ComponentToolReceipt } from "../generated/ComponentToolReceipt";
import type { OperationRecord } from "../generated/OperationRecord";

const states: Record<string,string>={accepted:"Accepted",running:"Running",reconciling:"Reconciling",succeeded:"Succeeded",failed:"Failed",cancelled:"Cancelled",uncertain:"Uncertain"};
export function scientificOperationLabel(record: OperationRecord | null | undefined) { return record ? states[record.status] ?? "Unknown" : "Unknown"; }
export function receiptOperationIds(receipts: readonly ComponentToolReceipt[]) {
  return [...new Set(receipts.filter(receipt=>receipt.mutation).flatMap(receipt=>[...(receipt.operation_id?[receipt.operation_id]:[]),...receipt.evidence.flatMap(evidence=>evidence.kind==="operation"?[evidence.operation_id]:[])]))];
}

/** Displays the real Operation owner; an Agent's own Ready state is unrelated. */
export function ScientificOperations({ ids, unknown=false, partial=false }: {ids:readonly string[];unknown?:boolean;partial?:boolean}) {
  const owner=useOperations(), outputs=useOutputs(), navigation=useNavigation(), runtime=useRuntimeSessions();
  const [failedReads,setFailedReads]=useState<ReadonlyMap<string,OperationRecord|undefined>>(new Map());
  const key=ids.join("\n");
  useEffect(()=>{
    let disposed=false;
    async function read() {
      const failures=new Map<string,OperationRecord|undefined>();
      for(const id of ids.slice(0,8)) {
        const previous=owner.getRecord(id);
        try { await owner.ensureOperation(id); } catch {failures.set(id,previous);}
        if(disposed)return;
      }
      setFailedReads(failures);
    }
    void read();return()=>{disposed=true;};
    // Subsequent states come from Operations.consumeEvents in the existing lane.
  },[key,owner]);
  if(!ids.length && !unknown && !partial) return null;
  const records=ids.map(id=>owner.getRecord(id));
  const unavailable=new Set([...failedReads].filter(([id,record])=>owner.getRecord(id)===record).map(([id])=>id));
  const active=records.filter((record,index)=>record&&!unavailable.has(ids[index])&&!terminal(record.status)).length;
  return <section className="at-scientific-work" aria-label="Scientific work"><details><summary>Scientific work · {unknown?"Unknown":unavailable.size?"Status unavailable":active?`${active} active`:ids.length?`${ids.length} observed`:"No operations observed"}{partial&&" · Partial"}</summary>
    {unknown&&<p>The original scientific operations are unavailable in this observation.</p>}
    {partial&&<p>Showing a bounded observation of recent operations.</p>}
    {ids.map((id,index)=>{const record=records[index],instance=record?operationWorkspaceInstance(record):undefined,session=instance?runtime.getInstance(instance):null,media=outputs.getSnapshot().media.filter(reference=>reference.operation_id===id);
      return <div className="at-scientific-operation" key={id}><button className="ca-evidence" data-operation-id={id} title={record?.operation.capability.id} onClick={()=>navigation.openOperation(id)}>{record?.operation.capability.id === "workspace.run_r" ? "R execution" : record?.operation.capability.id.replaceAll("_"," ") ?? "Original operation"} · {unavailable.has(id)?"Status unavailable":scientificOperationLabel(record)} ↗</button>
        <small>{instance?`R session · ${session?.name??instance}`:record?.operation.capability.id.startsWith("workspace.")?"R session · Unknown":record?`Target · ${record.operation.target.kind}: ${record.operation.target.identity}`:"Target · Unknown"}</small>
        {record?.error&&<p>{record.error}</p>}{media.map(reference=><button className="ca-evidence" key={reference.sequence} onClick={()=>navigation.locatePlot(reference)}>Open original plot {reference.sequence} ↗</button>)}
      </div>;
    })}
  </details></section>;
}

export function NativeScientificWork({task}:{task:AgentTaskSummary}) {
  const owner=useAgentTasks(), work=owner.getSnapshot().scientific.get(task.task.task_id);
  return <ScientificOperations ids={work?.operationIds??[]} unknown={!!work&&(work.unavailable||!work.attributable)} partial={work?.partial}/>;
}

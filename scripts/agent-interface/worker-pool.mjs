import assert from 'node:assert/strict';

export function parseConcurrency(value='1') {
  const concurrency=Number(value);
  assert.ok(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=3,'concurrency must be 1..3');
  return concurrency;
}

/** Test orchestration only. Each work item owns its complete isolated lifetime. */
export async function runBoundedCases(items,concurrency,work,onSettled=()=>{}) {
  concurrency=parseConcurrency(concurrency);
  const outcomes=new Array(items.length),reportingErrors=[];
  let next=0;
  async function worker() {
    for(;;){
      const index=next++;if(index>=items.length)return;
      let outcome;
      try {outcome={status:'fulfilled',value:await work(items[index],index)};}
      catch(reason){outcome={status:'rejected',reason};}
      outcomes[index]=outcome;
      try {await onSettled(outcome,index);}
      catch(error){reportingErrors.push({index,error});}
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker));
  reportingErrors.sort((a,b)=>a.index-b.index);
  return {outcomes,reportingErrors};
}

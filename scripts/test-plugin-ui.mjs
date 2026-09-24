import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { compilePublicUiSdk } from "./fixtures/plugin-ui.mjs";
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"rho-public-ui-"));
try {
  const sdk=await import(pathToFileURL(compilePublicUiSdk(directory)).href);
  const init={protocol_version:1,connection:"connection",view:{view:"view",state:{text:""},state_version:0}};
  const channel=new MessageChannel(),client=new sdk.PluginViewClient(channel.port1,init);
  let response=0;
  channel.port2.on("message",message=>channel.port2.postMessage({protocol_version:1,connection:"connection",view:"view",sequence:++response,request:message.request,ok:true,result:message.body}));
  const result=await client.query({id:"fixture.read",version:1},{text:"中文 Ω"});
  assert.equal(result.arguments.text,"中文 Ω");
  const control=await client.control({id:"fixture.answer",version:2},{value:"临时答复"});
  assert.deepEqual(control,{type:"control",capability:{id:"fixture.answer",version:2},arguments:{value:"临时答复"}});
  await assert.rejects(client.query({id:"fixture.read",version:1},{text:"x".repeat(sdk.MAX_UI_MESSAGE_BYTES)}),/quota/);
  client.dispose();channel.port2.close();
  await assert.rejects(client.operation("op"),/closed/);
  const staleChannel=new MessageChannel(),stale=new sdk.PluginViewClient(staleChannel.port1,init);
  staleChannel.port2.on("message",message=>staleChannel.port2.postMessage({protocol_version:1,connection:"another",view:"view",sequence:1,request:message.request,ok:true,result:null}));
  await assert.rejects(stale.query({id:"fixture.read",version:1},{}),/identity or sequence/);
  stale.dispose();staleChannel.port2.close();
  const errorChannel=new MessageChannel(),errorClient=new sdk.PluginViewClient(errorChannel.port1,init);
  errorChannel.port2.on("message",message=>errorChannel.port2.postMessage({protocol_version:1,connection:"connection",view:"view",sequence:1,request:message.request,ok:false,error:"Original commit remains pending",diagnostic:{operation_id:"original-op",recovery:{retained:true}}}));
  await assert.rejects(errorClient.operation("original-op"),error=>error instanceof sdk.ViewRequestError && error.diagnostic.operation_id==="original-op" && error.diagnostic.recovery.retained);
  errorClient.dispose();errorChannel.port2.close();
  const quotaChannel=new MessageChannel(),quota=new sdk.PluginViewClient(quotaChannel.port1,init);
  const pending=Array.from({length:sdk.MAX_UI_PENDING},()=>quota.operation("op").catch(e=>e));
  await assert.rejects(quota.operation("op"),/quota/);
  quota.dispose();quotaChannel.port2.close();await Promise.all(pending);
  const bytes=new TextEncoder().encode("中文 Ω\n".repeat(50000));
  const sha=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),n=>n.toString(16).padStart(2,"0")).join("");
  const owner={plugin:"example.resources",instance:"source",revision:"sha256:"+"a".repeat(64),artifact:"sha256:"+"b".repeat(64)};
  const reference={owner,resource:"resource",digest:"sha256:"+sha,bytes:bytes.length,media_type:"text/html"};
  let resourceReads=0;
  const reader={query:async(cap,args)=>{
    assert.equal(cap.id,"resources.read");resourceReads++;
    const end=Math.min(args.offset+args.limit,bytes.length);
    return {data:{reference:structuredClone(reference),offset:args.offset,base64:Buffer.from(bytes.slice(args.offset,end)).toString("base64"),next:end===bytes.length?null:end}};
  }};
  assert.deepEqual(await sdk.readResource(reader,reference),bytes);assert.ok(resourceReads>1);
  await assert.rejects(sdk.readResource(reader,reference,{maxBytes:10}),/limit/);
  for(const corrupt of [
    part=>({...part,next:1}),part=>({...part,offset:1}),part=>({...part,base64:""}),
    part=>({...part,reference:{...part.reference,owner:{...owner,instance:"another"}}}),
    part=>({...part,base64:Buffer.alloc(Buffer.from(part.base64,"base64").length).toString("base64")}),
  ]) await assert.rejects(sdk.readResource({query:async(cap,args)=>({data:corrupt((await reader.query(cap,args)).data)})},reference),/identity|range|integrity|incomplete/);
  const controller=new AbortController();let stoppedReads=0;
  await assert.rejects(sdk.readResource({query:async(cap,args)=>{stoppedReads++;controller.abort();return reader.query(cap,args);}},reference,{signal:controller.signal}),/stopped/);
  assert.equal(stoppedReads,1);
  const empty={...reference,bytes:0,digest:"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"};let authorizedEmpty=false;
  assert.equal((await sdk.readResource({query:async()=>{authorizedEmpty=true;return {data:{reference:empty,offset:0,base64:"",next:null}};}},empty)).length,0);
  assert.equal(authorizedEmpty,true);
  console.log("Public resource reads verify multibyte chunk assembly, immutable identity, exact ranges, final digest, cancellation and empty-resource authority.");
  console.log("External public UI SDK compiles; Unicode, quotas, stale connections and disposal verified.");
} finally {fs.rmSync(directory,{recursive:true,force:true});}

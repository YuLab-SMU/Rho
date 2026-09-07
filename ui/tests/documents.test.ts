import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPatch } from 'diff';
import { DocumentModel, filePatch, sha256 } from '../src/documents';
import { Studio } from '../src/studio';
import { HostClient } from '../src/host-client';
import type { OperationRecord } from '../src/generated/OperationRecord';
import type { Invocation } from '../src/generated/Invocation';

function document(raw:string,path:string|null='中文 文件.R') {
  return new DocumentModel({id:'document-one',path,raw:raw.replace(/^\uFEFF/,''),bom:raw.startsWith('\uFEFF'),eol:raw.includes('\r\n')?'\r\n':'\n',baseRaw:path?raw:null,baseHash:'sha256:original',readonly:null,byteSize:raw.length,anchor:0,head:0,scrollTop:0,scrollLeft:0});
}
function fixture(){const client=new HostClient('test');const s=new Studio(client);s.info={project_root:'/project',runtime:'ark',capabilities:[{capability:{id:'workspace.run_r',version:1}} as never]};s.connected=true;s.runtime={state:'idle',session_id:'session',processes:[],observed_at_ms:1,notices:[]};vi.spyOn(client,'writeState').mockImplementation(async(_project,state)=>({...state,version:crypto.randomUUID()}));return {s,client};}
function saved(request:Invocation,hash:string,status='succeeded'):OperationRecord{return {operation:{operation_id:'op-test',client_request_id:request.client_request_id,capability:request.capability,idempotency_scope:'/project'} as never,status:status as never,outcome:status as never,updated_at_ms:1,cancellation_requested:false,recovery:null,error:status==='succeeded'?null:'disk conflict',output:{after:{files:[{path:'中文 文件.R',sha256:hash}]}}};}
afterEach(()=>{vi.restoreAllMocks();});
describe('document byte and save discipline',()=>{
  it('preserves BOM and CRLF, including unchanged mixed line endings',()=>{const d=document('\uFEFF甲\r\n乙\n丙\r\n');d.update(d.state.update({changes:{from:2,to:3,insert:'新\n行'}}));expect(d.raw).toBe('\uFEFF甲\r\n新\r\n行\n丙\r\n');});
  it('uses a real diff with Unicode paths and exact byte line endings',()=>{const before='\uFEFF甲\r\n乙\r\n',after='\uFEFF甲\r\n新\r\n';const patch=filePatch('中文 文件.R',before,after);expect(applyPatch(before,patch,{autoConvertLineEndings:false})).toBe(after);});
  it.each(['中文 文件.R','quoted"name.R','empty.R'])('Git creates only the intended path %s',path=>{const directory=mkdtempSync(join(tmpdir(),'rho-diff-'));try{const value=path==='empty.R'?'':'\uFEFFx <- 1\r\n';const patch=filePatch(path,null,value);execFileSync('git',['apply','-'],{cwd:directory,input:patch});expect(readdirSync(directory)).toEqual([path]);expect(readFileSync(join(directory,path),'utf8')).toBe(value);}finally{rmSync(directory,{recursive:true,force:true});}});
  it('refuses oversized patches without truncating text',()=>{expect(()=>filePatch('large.R',null,'中'.repeat(80000))).toThrow('200 KiB');});
  it('keeps edits made during a save dirty and records only the saved snapshot',async()=>{
    const {s,client}=fixture(),d=document('x <- 1\n');d.replace('x <- 2\n');s.documents.items.set(d.id,d);
    let release!:(r:OperationRecord)=>void;let request!:Invocation;
    vi.spyOn(client,'invoke').mockImplementation(async(_p,input)=>{request=input;return new Promise(resolve=>{release=resolve;});});
    const save=s.documents.save(d);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    d.update(d.state.update({changes:{from:d.state.doc.length,insert:'y <- 3\n'}}));
    release(saved(request,await sha256('x <- 2\n')));await save;
    expect(d.draft.baseRaw).toBe('x <- 2\n');expect(d.raw).toBe('x <- 2\ny <- 3\n');expect(d.dirty).toBe(true);s.stop();
  });
  it.each(['failed','uncertain','wrong-digest','network'])('never runs a file after %s save',async(mode)=>{
    const {s,client}=fixture(),d=document('x <- 1\n');d.replace('x <- 2\n');s.documents.items.set(d.id,d);
    const invoke=vi.spyOn(client,'invoke').mockImplementation(async(_p,input)=>{if(mode==='network')throw new Error('network interrupted');return saved(input,mode==='wrong-digest'?'sha256:wrong':await sha256(d.raw),mode==='uncertain'?'uncertain':mode==='failed'?'failed':'succeeded');});
    await expect(s.documents.runFile(d)).rejects.toThrow();expect(invoke).toHaveBeenCalledTimes(1);expect(invoke.mock.calls[0][1].capability.id).toBe('project.apply_patch');expect(d.dirty).toBe(true);if(mode==='network')expect(s.pending[0].invocation.client_request_id).toBe(invoke.mock.calls[0][1].client_request_id);s.stop();
  });
  it('runs exactly the click snapshot after a confirmed save despite later typing',async()=>{
    const {s,client}=fixture(),d=document('x <- 1\n');d.replace('x <- 2\n');s.documents.items.set(d.id,d);
    const invoke=vi.spyOn(client,'invoke').mockImplementation(async(_p,input)=>{if(input.capability.id==='project.apply_patch'){d.replace('x <- 999\n');return saved(input,await sha256('x <- 2\n'));}return saved(input,'unused');});
    await s.documents.runFile(d);expect(invoke).toHaveBeenCalledTimes(2);expect(invoke.mock.calls[1][1].arguments).toEqual({code:'x <- 2\n'});expect(d.raw).toBe('x <- 999\n');expect(d.dirty).toBe(true);s.stop();
  });
});

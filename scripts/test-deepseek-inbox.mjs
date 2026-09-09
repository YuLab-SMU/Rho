// Verify the installed native Inbox replay/clear semantics with a disposable
// durable journal. No Agent process, provider request or user session is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const version='0.1.2-alpha.2';
const data=process.platform==='darwin'?path.join(os.homedir(),'Library/Application Support'):process.platform==='win32'?process.env.LOCALAPPDATA:process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local/share');
const components=process.env.RHO_AGENT_COMPONENTS_DIR||path.join(data,'rho/agent-components');
const native=path.join(components,`deepseek-${version}`,'node_modules/@deepseek-ai/dsh-agent');
const component=path.join(components,`deepseek-${version}`);
assert.equal(JSON.parse(fs.readFileSync(path.join(component,'node_modules/@deepseek-ai/dsh/package.json'),'utf8')).version,version);
const agentVersion=JSON.parse(fs.readFileSync(path.join(native,'package.json'),'utf8')).version;
assert.equal(agentVersion,JSON.parse(fs.readFileSync(path.join(component,'package-lock.json'),'utf8')).packages['node_modules/@deepseek-ai/dsh-agent'].version,'Installed native Inbox must match the component lock; this check never installs or updates it.');
const {Inbox}=await import(pathToFileURL(path.join(native,'lib/index.js')).href);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-native-inbox-')),journal=path.join(directory,'events.json');
fs.writeFileSync(journal,'[]');
function session(){return{ownEvents:()=>JSON.parse(fs.readFileSync(journal,'utf8')),append(type,data){const events=this.ownEvents(),event={seq:events.length+1,type,data:structuredClone(data)};events.push(event);fs.writeFileSync(journal,JSON.stringify(events));return event;}};}
const observed={inserted:[],discarded:[],claimed:[]};
const notifications=Object.fromEntries(Object.keys(observed).map(k=>[k,message=>observed[k].push(message.id)]));
try{
 let inbox=new Inbox(session(),notifications);
 inbox.append('next-turn',{id:'old-turn',role:'user',content:[{type:'text',text:'must not run later'}]});
 inbox.append('next-step',{id:'old-step',role:'user',content:[{type:'text',text:'must not run later either'}]});
 inbox=new Inbox(session(),notifications); // Crash after durable insertion, before claim.
 assert.equal(inbox.hasPending,true);assert.deepEqual(inbox.nextTurn.map(m=>m.id),['old-turn']);
 inbox.clear(); // The installed ACP close calls agent.cancel(), which calls this method.
 inbox=new Inbox(session(),notifications);assert.equal(inbox.hasPending,false);
 inbox.append('next-turn',{id:'fresh',role:'user',content:[{type:'text',text:'new instruction'}]});
 assert.deepEqual(inbox.claim('next-turn','new-native-turn').map(m=>m.id),['fresh']);
 assert.deepEqual(observed.discarded,['old-step','old-turn']);assert.deepEqual(observed.claimed,['fresh']);
 console.log(JSON.stringify({nativeComponent:version,nativeAgent:agentVersion,crashBeforeClaim:true,clearPersisted:true,executedOnlyNewInput:true,passed:true}));
}finally{fs.rmSync(directory,{recursive:true,force:true});}

// Real OpenSSH, owned loopback listener, throwaway keys and private configuration.
// No system service, user ssh config, authorized_keys or known_hosts is changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
function deadline(promise,label,ms=10000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(timer));}
export async function startLoopbackSsh(directory,bin){
  assert.equal(process.platform,'darwin','This acceptance currently uses the macOS OpenSSH installation');
  const root=path.join(directory,'ssh');fs.mkdirSync(root,{mode:0o700});
  for(const name of ['host','client'])execFileSync('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(root,name)],{timeout:10000});
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const user=os.userInfo().username;
  fs.writeFileSync(path.join(root,'sshd_config'),`ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${root}/host\nPidFile ${root}/pid\nAuthorizedKeysFile ${root}/client.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${user}\nAllowTcpForwarding no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nPermitUserRC no\nLogLevel VERBOSE\n`);
  const hostKey=fs.readFileSync(path.join(root,'host.pub'),'utf8').trim().split(' ').slice(0,2).join(' ');
  fs.writeFileSync(path.join(root,'known_hosts'),`[127.0.0.1]:${port} ${hostKey}\n`);
  fs.writeFileSync(path.join(root,'ssh_config'),`Host rho-test-loopback\n HostName 127.0.0.1\n Port ${port}\n User ${user}\n IdentityFile ${root}/client\n IdentityAgent none\n IdentitiesOnly yes\n UserKnownHostsFile ${root}/known_hosts\n GlobalKnownHostsFile /dev/null\n BatchMode yes\n StrictHostKeyChecking yes\n ControlMaster no\n ControlPersist no\n ClearAllForwardings yes\n`);
  fs.writeFileSync(path.join(bin,'ssh'),`#!/bin/sh\nexec /usr/bin/ssh -F ${quote(path.join(root,'ssh_config'))} "$@"\n`,{mode:0o700});
  execFileSync('/usr/sbin/sshd',['-t','-f',path.join(root,'sshd_config')],{timeout:10000});
  const child=spawn('/usr/sbin/sshd',['-D','-e','-f',path.join(root,'sshd_config')],{stdio:['ignore','ignore','pipe']});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const log=path.join(root,'sshd.log');let output='';
  const stop=async()=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    child.kill('SIGTERM');await deadline(exited,'Owned loopback sshd stop');
  };
  try {
    await deadline(new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.stderr.on('data',bytes=>{output+=bytes;fs.appendFileSync(log,bytes);if(output.includes(`Server listening on 127.0.0.1 port ${port}.`))resolve();});
      exited.then(status=>reject(Error(`Owned sshd exited ${JSON.stringify(status)}: ${output}`)));
    }),'Owned loopback sshd startup');
  }catch(error){await stop();throw error;}
  return {host_alias:'rho-test-loopback',port,log,stop,connections:()=>output.split('Accepted publickey for ').length-1};
}

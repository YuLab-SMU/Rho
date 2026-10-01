import {expect,it} from 'vitest';
import {fileContext} from '../src/agent-source.js';
const provider={instance:'files',plugin:'org.rho.files',revision:'revision',artifact:'artifact'};
it('keeps exact native identity and digest when the selection changes',()=>{
 const file={path:'研究.R',sha256:'original',native_identity:'native',byte_size:5,encoding:'utf-8'};
 const input=fileContext(provider,'window',file,'text');file.path='new.R';file.sha256='new';
 expect(input.reference.selector).toMatchObject({path:'研究.R',sha256:'original',native_identity:'native'});
 expect(()=>fileContext(provider,'window',null,'text')).toThrow();
 expect(()=>fileContext(provider,'window',file,'execute')).toThrow();
});

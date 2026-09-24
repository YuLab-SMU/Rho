import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-files-types-'));
try {
  fs.cpSync(path.join(root, 'plugins/files/sdk'), path.join(directory, 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(directory, 'consumer.ts'), `import type {ReadFileArguments,FilePage,TextPage,SearchTextArguments,SearchTextPage,ListDirectoryArguments,DirectoryPage,SearchFilesArguments,FileSearchResult,ProjectSnapshot,ProjectPatchResult,ProjectPatchRecovery} from './sdk/index.js';
const file:ReadFileArguments={path:'分析.R',offset:0,limit_bytes:16384,expected_sha256:null};
const directory:ListDirectoryArguments={path:'',after_name:null,limit:200};
const search:SearchTextArguments={text:'中文',case_sensitive:true,directory:'',filename_contains:'.R',show_hidden:false,limit_matches:100,continuation:null};
const names:SearchFilesArguments={text:'分析',show_hidden:false,continuation:null};
function next(page:TextPage){return page.continuation?.file.native_identity??page.skipped?.reason;}
function findings(page:SearchTextPage){return page.matches.map(item=>item.read);}
function bytes(page:FilePage){return [page.file.sha256,page.offset,page.bytes,page.has_more];}
function listing(page:DirectoryPage,search:FileSearchResult){return [page.next_name,search.continuation,search.notices];}
function patch(result:ProjectPatchResult){return [result.before.git?.head,result.after.git?.head,result.changed_paths,result.committed_to_git];}
function recovery(before:ProjectSnapshot):ProjectPatchRecovery{return {project_root:before.root,before,affected_paths:['分析.R']};}
// @ts-expect-error A text continuation cannot omit its native file identity.
const incomplete:TextPage['continuation']={project:'/project',line:2,byte_offset:8};
void [file,directory,search,names,next,findings,bytes,listing,patch,recovery,incomplete];
`);
  execFileSync(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', directory, path.join(directory, 'consumer.ts')], { cwd: directory, stdio: 'inherit' });
  console.log('Independent Files contract consumer compiled with only public declarations.');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=path.dirname(fileURLToPath(import.meta.url));
// Uses an existing compiler and cached locked dependencies. No toolchain install.
execFileSync(process.env.RHO_PLUGIN_CARGO || "cargo", ["build","--locked","--offline","-p","rho-r-backend"], {cwd:root,stdio:"inherit"});
fs.mkdirSync(path.join(root,"dist"),{recursive:true});
const target=process.env.CARGO_TARGET_DIR ? path.resolve(root,process.env.CARGO_TARGET_DIR) : path.join(root,"target");
fs.copyFileSync(path.join(target,"debug/rho-r-backend"),path.join(root,"dist/rho-r-backend"));
fs.chmodSync(path.join(root,"dist/rho-r-backend"),0o755);

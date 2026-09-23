import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function files(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), name) : [name];
  }).sort();
}

/** Runs serially with the existing Rust -> TypeScript generation. */
export function syncPluginProtocol(root, temp, mode) {
  const generated = path.join(temp, "plugin-protocol");
  execFileSync("cargo", ["run", "--manifest-path", path.join(root, "Cargo.toml"), "-p", "rho-plugin-protocol",
    "--bin", "export-plugin-protocol", "--locked", "--offline", "--", generated], { stdio: "inherit" });
  const committed = path.join(root, "sdk/plugin-protocol");
  for (const section of ["types", "schema"]) {
    const names = files(path.join(generated, section));
    if (mode === "check") assert.deepEqual(files(path.join(committed, section)), names, "plugin protocol inventory changed");
    for (const name of names) {
      let source = fs.readFileSync(path.join(generated, section, name), "utf8").replace(/[ \t]+$/gm, "");
      // Public ESM declarations must also work in NodeNext projects, not only
      // under the Studio bundler's extensionless module resolution.
      if (section === "types") source = source.replace(/(from\s+["'])(\.[^"']+)(["'])/g,
        (_match, start, specifier, end) => `${start}${specifier}.js${end}`);
      const target = path.join(committed, section, name);
      if (mode === "generate") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
      } else assert.equal(fs.readFileSync(target, "utf8"), source, `stale plugin protocol: ${section}/${name}`);
    }
    if (mode === "generate") for (const name of files(path.join(committed, section))) {
      if (!names.includes(name)) fs.unlinkSync(path.join(committed, section, name));
    }
  }
  const index = files(path.join(generated, "types")).map(name =>
    `export type * from "./types/${name.replace(/\.ts$/, ".js")}";`).join("\n") + "\n";
  if (mode === "generate") fs.writeFileSync(path.join(committed, "index.d.ts"), index);
  else assert.equal(fs.readFileSync(path.join(committed, "index.d.ts"), "utf8"), index, "stale plugin protocol exports");
}

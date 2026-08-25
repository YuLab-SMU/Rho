import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require(path.join(repositoryRoot, "desktop/node_modules/typescript/lib/typescript.js"));
const transportRoot = path.join(repositoryRoot, "desktop/ui/src/transport");

function productionTransportFiles(directory = transportRoot) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated") files.push(...productionTransportFiles(entryPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|tsx)$/u.test(entry.name)) continue;
    if (/\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry.name)) continue;
    files.push(entryPath);
  }
  return files.sort();
}

function invokeCallee(node) {
  if (ts.isIdentifier(node) && node.text === "invoke") return "invoke";
  if (ts.isPropertyAccessExpression(node) && node.name.text === "invoke") {
    return node.getText();
  }
  if (
    ts.isElementAccessExpression(node)
    && node.argumentExpression != null
    && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === "invoke"
  ) return node.getText();
  return null;
}

function directInvokeCalls(source, filename = "fixture.ts") {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = invokeCallee(node.expression);
      if (callee != null) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        calls.push({ callee, line: position.line + 1, column: position.character + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

assert.equal(directInvokeCalls('invoke("one_line")').length, 1);
assert.equal(directInvokeCalls(`invoke<{
  readonly version: string;
}>("multiline_generic")`).length, 1);
assert.equal(directInvokeCalls('window.__TAURI_INTERNALS__.invoke("property")').length, 1);
assert.equal(directInvokeCalls('window.__TAURI_INTERNALS__["invoke"](command)').length, 1);
assert.equal(directInvokeCalls("createGeneratedCommands(invoke)").length, 0);

const violations = [];
const files = productionTransportFiles();
for (const file of files) {
  const relative = path.relative(repositoryRoot, file).split(path.sep).join("/");
  for (const call of directInvokeCalls(fs.readFileSync(file, "utf8"), file)) {
    violations.push(`${relative}:${call.line}:${call.column}: direct ${call.callee}(...) bypasses a generated transport facet`);
  }
}

assert.deepEqual(
  violations,
  [],
  `Production transports must pass invoke into Rust-generated command factories:\n${violations.join("\n")}`,
);

console.log(`Generated transport boundary passed: ${files.length} production files, 0 direct invoke calls`);

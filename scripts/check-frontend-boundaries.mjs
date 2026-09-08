import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../ui/node_modules/typescript/lib/typescript.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const domains = new Set(["session", "operations", "console", "objects", "packages", "files", "documents", "outputs", "media-cache", "plots"]);
const stem = (file) => file.replace(/\.[^.]+$/, "");
const domain = (file) => domains.has(stem(file)) ? stem(file) : null;
const panel = (file) => file.startsWith("panels/") || ["app-shell.tsx", "commands.ts"].includes(file);
const transport = (file) => file === "host-client.ts";
const ui = (file) => panel(file) || file.endsWith(".tsx") || ["studio.ts", "context.ts", "app-shell.tsx", "app.ts", "layout-host.tsx", "builtin-panel-renderers.tsx", "primitives.tsx", "icons.tsx"].includes(file);
const shared = (file) => file.startsWith("shared/") || file.startsWith("generated/") || file.endsWith("-ports.ts");
const domGlobals = new Set(["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "Window", "MutationObserver", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "CustomEvent"]);
const mutations = new Set(["set", "add", "delete", "clear", "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const forbiddenPublications = new Set(["emit", "persist", "publish", "subscribeChannels", "channelSnapshot"]);
function walk(node, visit) { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); }
function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node))) node = node.expression;
  return node;
}
function property(node) {
  node = unwrap(node);
  return ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
}
function names(binding) {
  if (ts.isIdentifier(binding)) return [binding];
  return binding.elements.flatMap((element) => ts.isBindingElement(element) ? names(element.name) : []);
}
function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(file) : /\.[cm]?tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Checks the actual import graph and owner references, independently of type errors. */
export function checkFrontendBoundaries(sourceRoot = path.join(repository, "ui/src")) {
  sourceRoot = path.resolve(sourceRoot);
  const files = collectFiles(sourceRoot);
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const relative = (file) => path.relative(sourceRoot, file).split(path.sep).join("/");
  const sources = new Map(files.map((file) => [relative(file), program.getSourceFile(file)]));
  const diagnostics = [], seen = new Set(), graph = new Map();
  function report(file, node, rule, detail) {
    const source = sources.get(file), location = source.getLineAndCharacterOfPosition(node.getStart(source));
    const issue = { file, line: location.line + 1, rule, message: detail };
    const key = JSON.stringify(issue);
    if (!seen.has(key)) { seen.add(key); diagnostics.push(issue); }
  }
  const resolve = (file, specifier) => {
    const found = ts.resolveModuleName(specifier, path.join(sourceRoot, file), program.getCompilerOptions(), ts.sys).resolvedModule;
    if (found) { const key = relative(found.resolvedFileName); if (sources.has(key)) return key; }
    return null;
  };
  for (const [file, source] of sources) {
    const edges = [];
    walk(source, (node) => {
      let literal;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literal = node.moduleSpecifier;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) literal = node.arguments[0];
      if (!literal || !ts.isStringLiteralLike(literal)) return;
      const specifier = literal.text, target = resolve(file, specifier);
      edges.push({ target, specifier, node });
      if (specifier.startsWith("flexlayout-react")) {
        const allowed = ["layout-model.ts", "layout-host.tsx", "builtin-panel-renderers.tsx"].includes(file)
          || (file === "app.ts" && specifier.endsWith(".css"));
        if (!allowed) report(file, node, "flexlayout-owner", "FlexLayout belongs to the layout implementation and UI adapters.");
      }
      if (panel(file) && target === "studio.ts") report(file, node, "global-container", "Panels depend on module hooks, never the Studio container.");
      if (panel(file) && transport(target ?? "")) report(file, node, "panel-transport", "Panels use module commands, never HostClient.");
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const item of node.importClause.namedBindings.elements)
          if ((item.propertyName ?? item.name).text === "useStudio") report(file, item, "global-container", "Use a module-specific hook; useStudio is forbidden.");
      }
    });
    graph.set(file, edges);
  }
  // Traverse helpers and re-exports too: a barrel must not hide a concrete owner.
  for (const [origin, source] of sources) {
    if (!domain(origin) && !shared(origin) && !panel(origin)) continue;
    const visited = new Set([origin]);
    function inspect(file, route) {
      for (const edge of graph.get(file) ?? []) {
        const next = edge.target, chain = [...route, next ?? edge.specifier];
        let reason;
        if (domain(origin)) {
          if (next && ((domain(next) && next !== origin) || ui(next) || transport(next) || next === "layout-model.ts" || next === "application-state.ts")) reason = "domain-dependency";
          if (/^(react(?:-dom)?(?:\/|$)|@radix-ui\/|@codemirror\/view(?:\/|$)|flexlayout-react(?:\/|$))/.test(edge.specifier)) reason = "domain-ui";
        } else if (shared(origin) && next && (domain(next) || ui(next) || transport(next) || next === "layout-model.ts")) reason = "shared-dependency";
        else if (panel(origin) && next && transport(next)) reason = "panel-transport";
        if (reason) report(origin, route.length === 1 ? edge.node : source, reason, `Forbidden dependency: ${chain.join(" -> ")}`);
        if (next && !visited.has(next) && !(panel(origin) && next === "context.ts")) { visited.add(next); inspect(next, chain); }
      }
    }
    inspect(origin, [origin]);
  }
  const completed = new Set(), active = [];
  function cycles(file) {
    if (completed.has(file)) return;
    active.push(file);
    for (const edge of graph.get(file) ?? []) if (edge.target) {
      const index = active.indexOf(edge.target);
      if (index >= 0) report(file, edge.node, "dependency-cycle", [...active.slice(index), edge.target].join(" -> "));
      else cycles(edge.target);
    }
    active.pop(); completed.add(file);
  }
  for (const file of sources.keys()) cycles(file);

  for (const [file, source] of sources) {
    const isPanel = panel(file), isDomain = !!domain(file), isStudio = file === "studio.ts";
    if (!isPanel && !isDomain && !isStudio && file !== "context.ts") continue;
    const ownerSymbols = new Set(), hookSymbols = new Set();
    const symbol = (node) => checker.getSymbolAtLocation(node);
    walk(source, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && resolve(file, node.moduleSpecifier.text) === "context.ts") {
        for (const item of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : []) {
          const imported = (item.propertyName ?? item.name).text;
          if (/^use[A-Z]/.test(imported)) hookSymbols.add(symbol(item.name));
          else if (imported === "studio") ownerSymbols.add(symbol(item.name));
        }
      }
      if (file === "context.ts" && ts.isFunctionDeclaration(node) && node.name?.text === "useStudio") report(file, node, "global-container", "The generic global container hook must be removed.");
    });
    function owned(node) {
      node = unwrap(node);
      if (!node) return false;
      if (ts.isIdentifier(node) && ownerSymbols.has(symbol(node))) return true;
      if (ts.isCallExpression(node)) {
        // Copying an array grants ownership of the new container, not its elements.
        if (["slice", "filter", "map", "flat", "flatMap", "toSorted", "toReversed", "toSpliced", "with"].includes(property(node.expression))
          && checker.isArrayType(checker.getTypeAtLocation(node))) return false;
        return hookSymbols.has(symbol(node.expression)) || owned(node.expression);
      }
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && owned(node.expression)) return true;
      const type = checker.getTypeAtLocation(node);
      return [type.symbol, type.aliasSymbol].some((s) => s?.declarations?.some((decl) => (domain(relative(decl.getSourceFile().fileName)) || relative(decl.getSourceFile().fileName) === "layout-model.ts")));
    }
    // Follow destructuring, aliases and snapshot-returning calls, not identifier spelling.
    let changed = true;
    while (changed) {
      changed = false;
      walk(source, (node) => {
        if (ts.isVariableDeclaration(node) && node.initializer && owned(node.initializer)) {
          for (const name of names(node.name)) { const s = symbol(name); if (s && !ownerSymbols.has(s)) { ownerSymbols.add(s); changed = true; } }
        }
      });
    }
    walk(source, (node) => {
      if (isDomain && ts.isIdentifier(node) && domGlobals.has(node.text)) {
        const s = symbol(node);
        if (s?.declarations?.some((decl) => /lib\.dom\.d\.ts$/.test(decl.getSourceFile().fileName))) report(file, node, "domain-dom", `Domain code must not depend on DOM global ${node.text}.`);
      }
      if (isPanel && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        && ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "setInterval"].includes(property(node))
        && ts.isIdentifier(node.expression) && ["window", "globalThis", "self"].includes(node.expression.text))
        report(file, node, property(node) === "setInterval" ? "panel-polling" : "panel-transport", "Panels cannot access transport or polling through browser globals.");
      if (isPanel && ts.isIdentifier(node) && ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "setInterval"].includes(node.text)) {
        const s = symbol(node);
        if (!s || s.declarations?.some((decl) => /lib\.(dom|webworker).*\.d\.ts$/.test(decl.getSourceFile().fileName)))
          report(file, node, node.text === "setInterval" ? "panel-polling" : "panel-transport", `Panels cannot access ${node.text}; use a module command.`);
      }
      if (isPanel && ts.isCallExpression(node)) {
        const name = property(node.expression);
        if (name && forbiddenPublications.has(name) && owned(node.expression.expression)) report(file, node, "owner-publication", "A panel cannot publish or persist another module's state.");
        if (name && mutations.has(name) && owned(node.expression.expression)) report(file, node, "owner-mutation", "A panel cannot mutate an owner's collection; call a domain command.");
        if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && ["Object", "Reflect"].includes(node.expression.expression.text)
          && ["assign", "set", "deleteProperty", "defineProperty", "defineProperties"].includes(name) && node.arguments[0] && owned(node.arguments[0]))
          report(file, node, "owner-mutation", "A panel cannot mutate owner state through Object/Reflect.");
      }
      if (isPanel) {
        let target;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
        if (ts.isDeleteExpression(node)) target = node.expression;
        if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && owned(target.expression)) report(file, node, "owner-mutation", "Model state is changed only through its owner's commands.");
      }
      if (isStudio) {
        const type = ts.isPropertyDeclaration(node) && node.type ? checker.getTypeAtLocation(node) : undefined;
        const cleanup = type && checker.isArrayType(type) ? checker.getIndexTypeOfType(type, ts.IndexKind.Number) : undefined;
        const cleanupSignatures = cleanup?.getCallSignatures() ?? [];
        const cleanupList = cleanupSignatures.length > 0 && cleanupSignatures.every((signature) =>
          signature.parameters.length === 0 && (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void) !== 0);
        if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) report(file, node, "composition-facade", "Studio cannot forward domain state through getters/setters.");
        if (ts.isPropertyDeclaration(node) && node.initializer && !cleanupList && (ts.isArrayLiteralExpression(node.initializer)
          || ts.isNewExpression(node.initializer) && ["Map", "Set", "WeakMap", "WeakSet"].includes(node.initializer.expression.getText(source))))
          report(file, node, "composition-state", "Domain collections belong to their owner, not Studio.");
        if (ts.isCallExpression(node) && ["query", "invoke", "getOperation", "subscribe"].includes(property(node.expression))) {
          let ancestor = node.parent;
          while (ancestor && !ts.isConstructorDeclaration(ancestor) && !ts.isMethodDeclaration(ancestor)) ancestor = ancestor.parent;
          if (!ancestor || !ts.isConstructorDeclaration(ancestor)) report(file, node, "composition-business", "Scientific calls belong to owner ports; Studio only wires them in its constructor.");
        }
      }
    });
  }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = checkFrontendBoundaries(process.argv[2]);
  for (const issue of issues) console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`);
  if (issues.length) { console.error(`${issues.length} frontend boundary violation(s).`); process.exitCode = 1; }
  else console.log("Frontend ownership, transport, mutation and dependency boundaries passed.");
}

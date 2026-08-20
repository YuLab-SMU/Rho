import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("desktop/dist/index.html", "utf8");
const css = fs.readFileSync("desktop/dist/styles.css", "utf8");
const js = fs.readFileSync("desktop/dist/app.js", "utf8");

for (const id of [
  "pluginDialog",
  "pluginDialogTitle",
  "pluginDialogClose",
  "pluginListView",
  "pluginList",
  "pluginGrantSection",
  "pluginGrantList",
  "pluginPermissionView",
  "pluginPermissionIdentity",
  "pluginPermissionConstraints",
  "pluginPermissionConsequence",
  "pluginPermissionPurpose",
  "pluginPermissionDeny",
  "pluginPermissionAllowOnce",
  "pluginPermissionAllowProject",
]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing trusted plugin UI control ${id}`);
}

assert.match(html, /data-menu-command="workspace-plugins"/);
assert.match(html, /Plugin-provided purpose \(untrusted text\)/);
assert.match(html, /Upgrades require review and receive new handles/);
assert.match(html, /This request is separate from Agent approvals and environment operations/);
assert.match(html, /id="pluginDialog" class="product-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="pluginDialogTitle"/);

for (const command of [
  "list_workspace_plugins",
  "request_workspace_plugin_enable",
  "list_plugin_permission_requests",
  "get_plugin_permission_request",
  "respond_plugin_permission",
  "list_plugin_grants",
  "revoke_plugin_grant",
]) {
  assert.equal(
    js.match(new RegExp(`command === ["']${command}["']`, "g"))?.length ?? 0,
    1,
    `${command} must have exactly one browser mock`,
  );
}

assert.match(js, /function renderWorkspacePlugins\(\)/);
assert.match(js, /strong\.textContent = plugin\.name/);
assert.match(js, /\$\("#pluginPermissionPurpose"\)\.textContent = purpose/);
assert.doesNotMatch(
  js.slice(js.indexOf("function reviewPluginPermission"), js.indexOf("async function requestWorkspacePluginEnable")),
  /innerHTML/,
  "untrusted plugin request rendering must not use innerHTML",
);
assert.match(js, /expectedProjectRevision: state\.plugins\.list\?\.project_revision/);
assert.match(js, /decision,\s*expectedProjectRevision:/);
assert.match(js, /if \(event\.key === "Escape"\)[\s\S]*closeWorkspacePluginDialog\(\)/);
assert.match(js, /raw_handle_exposed:/);
assert.match(js, /purpose_rendered_as_text:/);
assert.match(js, /scenario === "workspace-plugins"/);
assert.match(js, /\["permission", "malicious-text"\]/);

assert.match(css, /\.plugin-dialog-surface\s*\{/);
assert.match(css, /\.plugin-permission-actions\s*\{/);
assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.plugin-permission-identity/);
assert.match(css, /overflow-wrap:\s*anywhere/);

console.log("Workspace plugin trusted UI contract checks passed.");

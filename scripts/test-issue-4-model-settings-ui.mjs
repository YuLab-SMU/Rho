import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "desktop", "dist", "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");

function sliceBetween(source, start, end, label) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${label} must be present and bounded`);
  return source.slice(from, to);
}

const mainDialog = sliceBetween(html, '<div id="agentLlmDialog"', '<div id="agentLlmProviderWizard"', "Model settings dialog");
const providerAdvanced = sliceBetween(mainDialog, '<details id="agentLlmProviderAdvanced"', '<details id="agentLlmProviderDanger"', "Provider Advanced");
const providerDanger = sliceBetween(mainDialog, '<details id="agentLlmProviderDanger"', "</details>", "Provider Danger zone");
const providerWizard = sliceBetween(html, '<div id="agentLlmProviderWizard"', '<div id="agentLlmModelDialog"', "Add provider wizard");
const modelDialog = sliceBetween(html, '<div id="agentLlmModelDialog"', '<div id="agentLlmModelDeleteDialog"', "Model editor");
const modelDanger = sliceBetween(modelDialog, '<details id="agentLlmModelDanger"', "</details>", "Model Danger zone");

for (const id of [
  "agentLlmProviderList",
  "agentLlmProviderDetail",
  "agentLlmCurrentSelection",
  "agentLlmCurrentStatus",
  "agentLlmCredential",
  "agentLlmCredentialStatus",
  "agentLlmModelList",
  "agentLlmOperationStatus",
  "agentLlmAddProvider",
  "agentLlmAddModel",
  "agentLlmEditModel",
  "agentLlmSaveCredential",
  "agentLlmTestModel",
  "agentLlmSelectDefault",
  "agentLlmRoutingTab",
  "agentLlmConnectionsTab",
  "agentLlmLibraryTab",
  "agentLlmRouteList",
  "agentLlmLibraryList",
]) assert.ok(mainDialog.includes(`id="${id}"`), `${id} must be in the default provider-card surface`);

assert.match(mainDialog, /id="agentLlmProviderList"[^>]*role="listbox"/);
assert.match(mainDialog, /id="agentLlmModelList"[^>]*role="listbox"/);
assert.match(mainDialog, /id="agentLlmOperationStatus"[^>]*role="status"[^>]*aria-live="polite"/);
assert.doesNotMatch(mainDialog, /id="agentLlmAdvanced"/);
assert.match(mainDialog, /id="agentLlmDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
assert.doesNotMatch(mainDialog, /id="agentLlmModelDisplayName"|id="agentLlmModelId"|id="agentLlmModelEnabled"/);

for (const id of [
  "agentLlmProviderDisplayName",
  "agentLlmProviderKind",
  "agentLlmRegisteredProviderId",
  "agentLlmProviderApiKeyEnv",
  "agentLlmProviderBaseUrlEnv",
  "agentLlmProviderWireApi",
  "agentLlmProviderApiKeyRequired",
  "agentLlmProviderDisableStreamOptions",
]) assert.ok(providerAdvanced.includes(`id="${id}"`), `${id} must be scoped to Provider Advanced`);
const providerConnection = sliceBetween(mainDialog, '<section class="agent-llm-section agent-llm-connection-section">', '<section class="agent-llm-section agent-llm-model-section">', "API connection section");
for (const id of ["agentLlmProviderBaseUrl", "agentLlmSaveProvider"]) {
  assert.ok(providerConnection.includes(`id="${id}"`), `${id} must be a common API connection control`);
}
assert.ok(mainDialog.indexOf('id="agentLlmProviderBaseUrl"') < mainDialog.indexOf('id="agentLlmProviderAdvanced"'));
assert.match(providerAdvanced, /<summary>Provider Advanced<\/summary>/);
assert.doesNotMatch(providerAdvanced, /\sopen(?:\s|>)/);
assert.ok(providerDanger.includes('id="agentLlmDeleteProvider"'), "Provider deletion must be isolated in its Danger zone");
assert.match(providerDanger, /<summary>Danger zone<\/summary>/);
assert.doesNotMatch(mainDialog.slice(0, mainDialog.indexOf('<details id="agentLlmProviderAdvanced"')), /Delete provider/);

for (const id of [
  "agentLlmWizardProviderName",
  "agentLlmWizardProviderKind",
  "agentLlmWizardBaseUrl",
  "agentLlmWizardCredential",
  "agentLlmWizardApiFormat",
  "agentLlmWizardModelId",
  "agentLlmWizardModelName",
  "agentLlmWizardContinue",
  "agentLlmWizardBack",
  "agentLlmWizardFinish",
  "agentLlmWizardStatus",
]) assert.ok(providerWizard.includes(`id="${id}"`), `${id} must be in the dedicated Add provider workflow`);
assert.match(providerWizard, /Connection[\s\S]*Model/);
assert.doesNotMatch(providerWizard.match(/<div id="agentLlmProviderWizard"[^>]*>/)?.[0] || "", /role=|aria-modal=/);
assert.match(providerWizard, /id="agentLlmWizardCredential" type="password" autocomplete="new-password" spellcheck="false"/);
assert.match(providerWizard, /id="agentLlmWizardStatus"[^>]*role="status"[^>]*aria-live="polite"/);
assert.doesNotMatch(mainDialog, /id="agentLlmWizardProviderName"/);

for (const id of [
  "agentLlmModelDisplayName",
  "agentLlmModelProvider",
  "agentLlmModelId",
  "agentLlmModelEnabled",
  "agentLlmModelType",
  "agentLlmModelToolCalling",
  "agentLlmModelReasoning",
  "agentLlmModelVisionInput",
  "agentLlmModelImageOutput",
  "agentLlmModelImageEdit",
  "agentLlmModelAudioInput",
  "agentLlmModelAudioOutput",
  "agentLlmModelStructuredOutput",
  "agentLlmModelWebSearch",
  "agentLlmModelEvidence",
  "agentLlmSaveModel",
  "agentLlmModelStatus",
]) assert.ok(modelDialog.includes(`id="${id}"`), `${id} must be in the dedicated Model editor`);
assert.ok(modelDanger.includes('id="agentLlmDeleteModel"'), "Model deletion must be isolated in its Danger zone");
assert.doesNotMatch(modelDialog.match(/<div id="agentLlmModelDialog"[^>]*>/)?.[0] || "", /role=|aria-modal=/);
assert.doesNotMatch(modelDialog.slice(0, modelDialog.indexOf('<details id="agentLlmModelDanger"')), /Delete model/);

assert.match(css, /\.agent-llm-shell\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*220px\)\s+minmax\(0,\s*1fr\)/s);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.agent-llm-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.match(css, /\.agent-llm-danger-zone/);
assert.match(css, /\.agent-llm-provider-card/);
assert.match(css, /\.agent-llm-route-card/);
assert.match(css, /\.agent-llm-library-card/);
assert.match(css, /\.agent-llm-operation-status\.(?:working|success|warning|error)/);
assert.match(css, /\.menu-popover\[hidden\]\s*\{\s*display:\s*none;/, "Closed menus must leave the accessibility tree");

for (const name of [
  "providerReadiness",
  "modelSelectorStatusLabel",
  "renderAgentLlmOperationStatus",
  "setAgentLlmOperationState",
  "syncAgentLlmOperationSubmissionState",
  "refreshAgentLlmWizardAccessibility",
  "openAgentLlmProviderWizard",
  "advanceAgentLlmProviderWizard",
  "finishAgentLlmProviderWizard",
  "openAgentLlmModelDialog",
  "switchAgentLlmView",
  "renderAgentLlmRouting",
  "renderAgentLlmLibrary",
  "persistAgentCapabilityRoute",
  "saveAgentLlmCredential",
  "maybeFailMockAgentLlm",
  "trapAgentLlmDialogFocus",
]) assert.match(js, new RegExp(`function ${name}\\b|async function ${name}\\b`), `${name} must exist`);

const dialogRender = sliceBetween(js, "function renderAgentLlmDialog()", "\nfunction openAgentLlmDialog", "Model settings renderer");
assert.match(dialogRender, /filter\(\(model\) => model\.provider_id === selectedProvider\?\.id\)/);
assert.match(dialogRender, /providerReadiness\(provider/);
assert.match(dialogRender, /providerModelCount/);
assert.match(js, /row\.setAttribute\("aria-selected"/);
assert.match(js, /"key missing": "Needs API key"/);
assert.match(js, /error: "Connection error"/);

const clearCredential = sliceBetween(js, "function clearAgentLlmCredentialInput()", "\nfunction agentProviderKindLabel", "Credential clearing helper");
for (const id of ["agentLlmCredential", "agentLlmWizardCredential"]) {
  assert.ok(clearCredential.includes(`#${id}`), `${id} must clear at the shared credential boundary`);
}
assert.doesNotMatch(js, /localStorage\.setItem\([^\n]*(?:credential|api.?key)|sessionStorage\.setItem\([^\n]*(?:credential|api.?key)/i);

const wizardAdvance = sliceBetween(js, "async function advanceAgentLlmProviderWizard()", "\nasync function finishAgentLlmProviderWizard", "Provider wizard Connection transition");
assert.match(wizardAdvance, /agent_llm_save_provider/);
assert.match(wizardAdvance, /agent_llm_set_credential/);
assert.match(wizardAdvance, /Provider saved; API key not stored/);
assert.match(wizardAdvance, /clearAgentLlmCredentialInput\(\)/);
assert.match(wizardAdvance, /Enter the provider Base URL before continuing[\s\S]*clearAgentLlmCredentialInput|clearAgentLlmCredentialInput\(\)[\s\S]*Enter the provider Base URL before continuing/);
const wizardFinish = sliceBetween(js, "async function finishAgentLlmProviderWizard()", "\nfunction openAgentLlmModelDialog", "Provider wizard Model transition");
assert.match(wizardFinish, /agent_llm_save_model/);
assert.doesNotMatch(wizardFinish, /agent_llm_select_model/);
assert.match(wizardFinish, /Assign it to a capability route/);
assert.match(wizardFinish, /Provider saved; model not saved/);

for (const state of ["working", "success", "warning", "error"]) {
  assert.ok(js.includes(`"${state}"`), `Operation state ${state} must be represented`);
}
for (const failure of ["save-provider", "set-credential", "save-model", "test-model", "select-model"]) {
  assert.ok(js.includes(`"${failure}"`), `Mock failure fixture ${failure} must exist`);
}
assert.match(js, /scenario === "model-settings"/);
assert.match(js, /previewParams\.get\("state"\) === "wizard"/);
for (const previewState of ["empty", "key-missing", "credential-unchecked", "storage-unavailable", "disabled-models", "no-models", "ready-to-test", "connection-error", "long-name"]) {
  assert.ok(js.includes(`"${previewState}"`), `Deterministic preview state ${previewState} must exist`);
}
assert.match(js, /root\.classList\.toggle\("agent-llm-parent-suspended", inert\)/);
assert.match(js, /active\?\.setAttribute\("role", "dialog"\)/);
assert.match(js, /active\?\.setAttribute\("aria-modal", "true"\)/);
assert.match(js, /agentLlmProviderWizard"\)\.classList\.remove\("hidden"\);\s*renderAgentLlmWizardStep\(\);\s*labelAgentLlmModal\("agentLlmWizardTitle"\)/);
assert.match(js, /agentLlmModelDialog"\)\.classList\.remove\("hidden"\);\s*labelAgentLlmModal\("agentLlmModelDialogTitle"\)/);
assert.match(css, /\.agent-llm-dialog\.agent-llm-parent-suspended\s*\{\s*display:\s*none;/);
assert.match(js, /!element\.closest\("\[inert\]"\)/);
assert.match(js, /event\.key === "Escape"/);
assert.match(js, /const nextIndex = activeIndex < 0[\s\S]*focusable\[nextIndex\]\.focus\(\)/);
assert.match(js, /const replacement = surface\.cloneNode\(true\)/);
assert.match(js, /event\.target\.closest\?\.\("button"\)/);
assert.match(js, /agentLlmDialog"\)\.addEventListener\("keydown"/);
assert.match(js, /requestAnimationFrame\(\(\) => \$\("#agentLlmClose"\)\.focus\(\)\)/);
assert.match(js, /state\.agentLlm\.returnFocusElement/);
assert.doesNotMatch(js, /async function saveAgentLlmConfiguration\(/);

console.log("Issue #4 Model settings and capability-routing contract checks passed.");

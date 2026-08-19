import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop", "dist", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "desktop", "dist", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "crates", "rho-server", "src", "coordinator.rs"), "utf8");

assert.match(js, /function userFacingError\(error, fallback/);
assert.match(js, /function reportUiFailure\(context, error, fallback\)/);
assert.match(js, /function userFacingStatus\(status, labels, fallback/);
assert.match(js, /function agentProviderFailureMessage\(error\)/);
for (const message of [
  "The underlying information changed. Refresh it and try again.",
  "The requested information is no longer available.",
  "This action is not allowed in the current project state.",
  "Rho could not reach the required service.",
  "The action was stopped.",
]) assert.ok(js.includes(message), `Missing friendly error projection: ${message}`);

for (const context of [
  "load run history",
  "load project guidance",
  "load Agent history",
  "respond to Agent approval",
  "stop R run",
  "compare runs",
  "load environment operations",
  "preview environment operation",
  "respond to environment operation",
  "save model provider",
  "delete model provider",
  "save model",
  "delete model",
  "assign Chat route",
  "save capability route",
  "discover provider models",
  "save API key",
  "remove stored API key",
]) assert.ok(js.includes(`reportUiFailure("${context}"`), `Missing projection boundary for ${context}`);

for (const rawProjection of [
  "Run history is unavailable: ${error}",
  "Project skills are unavailable: ${error}",
  "Agent history is unavailable: ${error}",
  "Environment operations are unavailable: ${error}",
]) assert.ok(!js.includes(rawProjection), `Raw backend error remains visible: ${rawProjection}`);

const timelineStart = js.indexOf("function renderAgentTimeline()");
const timelineEnd = js.indexOf("\nfunction renderTaskRail", timelineStart);
const timeline = js.slice(timelineStart, timelineEnd);
assert.match(timeline, /agentModelDisplayName\(turn\.model\)/);
assert.match(timeline, /agentTurnFailureMessage\(turn\.error_message\)/);
assert.match(timeline, /detail && \(!selected \|\| turn\.error_message\)/);
assert.doesNotMatch(timeline, /event\.request_id|meta\.push\(event\.request_id\)/);
assert.doesNotMatch(timeline, /aisdk|Ark session|broker policy/);

const providerFailureStart = js.indexOf("function agentProviderFailureMessage(error)");
const providerFailureEnd = js.indexOf("\nfunction agentTurnFailureMessage", providerFailureStart);
const providerFailureSource = js.slice(providerFailureStart, providerFailureEnd);
const providerFailureMessage = new Function(
  "truncateText",
  `return (${providerFailureSource});`,
)((value, maximum) => String(value).slice(0, maximum));
assert.match(providerFailureMessage("API request failed with status 429\nURL: https://private.example/messages"), /HTTP 429[\s\S]*rate limit or quota/);
assert.match(providerFailureMessage("HTTP 401 from https://private.example"), /authentication[\s\S]*HTTP 401/);
assert.match(providerFailureMessage("Provider service HTTP 503 at https://private.example"), /HTTP 503[\s\S]*temporarily unavailable/);
assert.doesNotMatch(providerFailureMessage("custom provider failure at https://private.example/private"), /private\.example/);
assert.match(js, /event\.event_type === "desktop\.agent_failed"[\s\S]*agentProviderFailureMessage\(event\.body\)/);
assert.match(js, /"desktop\.agent_failed:": "Provider request failed"/);
assert.match(server, /"desktop\.agent_failed" => Some\(\([\s\S]*"Provider request failed"/);
assert.match(server, /error_message: completion\.error_message\.clone\(\)/,
  "Terminal Provider failure must be persisted on the Agent turn");
assert.match(server, /MAX_PROVIDER_FAILURE_BYTES: usize = 2 \* 1024/);
assert.match(js, /const code = approval\.code \|\| argumentsObject\.code \|\| ""/);
assert.doesNotMatch(js, /approval\.code \|\| argumentsObject\.code \|\| approval\.arguments_json/);
assert.doesNotMatch(js, /Ark PID/);
assert.doesNotMatch(js, /id="startupDetails"|id="startupTechnicalDetail"|id="startupLogPath"/);
assert.match(js, /\["R session", runtime\.r_version/);
assert.doesNotMatch(js.slice(js.indexOf("async function openAboutDialog()"), js.indexOf("\nfunction updateFailureMessage")), /info\.commit|runtime\.rscript|aisdk/);

const projectSkills = js.slice(js.indexOf("function renderProjectSkills()"), js.indexOf("\nasync function loadProjectSkills"));
assert.doesNotMatch(projectSkills, /skill\.id|instructions_path|references\.join|discovery_error}`/);
assert.match(projectSkills, /Provided by this project/);

const installedHelp = js.slice(js.indexOf("function renderInstalledHelp("), js.indexOf("\nfunction renderLocalHelp"));
assert.doesNotMatch(installedHelp, /state\.installedHelp\.status;/);
assert.doesNotMatch(installedHelp, /record\.notices.*join|bounded response/);

const localHelp = js.slice(js.indexOf("function renderLocalHelp()"), js.indexOf("\nasync function showLocalHelp"));
assert.doesNotMatch(localHelp, /Package root|Library root|transport limit/);

const projectReferences = js.slice(js.indexOf("function renderProjectReferences()"), js.indexOf("\nasync function showProjectReferences"));
assert.doesNotMatch(projectReferences, /state\.projectReferences\.status;|record\.notices.*join|bounded scan/);

const environmentSummary = js.slice(js.indexOf("function renderEnvironmentSummary()"), js.indexOf("\nfunction renderLastRenderCard"));
assert.doesNotMatch(environmentSummary, /`renv \$\{renvStatus\}`/);
assert.match(environmentSummary, /Package versions are not recorded/);

const packageList = js.slice(js.indexOf("function renderPackageList()"), js.indexOf("\nfunction abbreviateLibrary"));
assert.doesNotMatch(packageList, /name\.title = pkg\.library|incomplete_reasons\.join|dependencyRoles\.error \|\| dependencyRoles\.state/);

const environmentOperation = js.slice(js.indexOf("function formatEnvironmentOperationSummary("), js.indexOf("\nfunction closeEnvironmentOperationDialog"));
assert.doesNotMatch(environmentOperation, /bounded drift|broker to mutate|Project library: \$\{args\.project_library\}|Project library: \$\{preview\.project_library/);
assert.doesNotMatch(environmentOperation, /reason = request\.reason \? `[^`]*\$\{request\.reason\}/);

const dataViewer = js.slice(js.indexOf("function renderDataViewer()"), js.indexOf("\nfunction dataViewerDelimitedText"));
assert.doesNotMatch(dataViewer, /bounded page|bounded viewer/);
assert.match(dataViewer, /dataViewerErrorFallback\(state\.dataViewer\.error\)/);
const dataViewerErrors = js.slice(js.indexOf("function dataViewerReadFailure("), js.indexOf("\nfunction renderDataViewer()"));
assert.match(dataViewerErrors, /The source changed; refresh this object before continuing/);
assert.match(dataViewerErrors, /The data page could not be shown\. Refresh the object and try again/);

const evidenceClaims = js.slice(js.indexOf("function renderEvidenceClaims()"), js.indexOf("\nfunction switchEvidenceTab"));
assert.doesNotMatch(evidenceClaims, /`\$\{claim\.kind\}/);
assert.match(js, /function claimKindLabel\(kind\)/);
assert.match(js, /function claimLimitationLabel\(limitation\)/);
assert.doesNotMatch(evidenceClaims, /note\.textContent = limitation/);
assert.match(js, /reportUiFailure\("create evidence claim"/);

const compare = js.slice(js.indexOf("function renderCompareResult()"), js.indexOf("\nfunction addProblem"));
assert.match(compare, /filter\(\(item\) => fieldLabels\[item\.field\]/);
assert.doesNotMatch(compare, /fieldLabels\[field\.field\] \|\| "Detail"/);

const agentRunReview = js.slice(js.indexOf("function renderAgentRunReview("), js.indexOf("\nfunction renderAgentReview"));
assert.match(agentRunReview, /document\.createElement\("details"\)/);
assert.doesNotMatch(agentRunReview, /appendAgentReviewSection\(outcome, "Traceback"/);

const advancedStart = html.indexOf('<details id="agentLlmProviderAdvanced"');
const advancedEnd = html.indexOf('<details id="agentLlmProviderDanger"', advancedStart);
const advancedSettings = html.slice(advancedStart, advancedEnd);
const modelDialogStart = html.indexOf('<div id="agentLlmModelDialog"');
const modelDialogEnd = html.indexOf('<div id="agentLlmModelDeleteDialog"', modelDialogStart);
const modelDialog = html.slice(modelDialogStart, modelDialogEnd);
assert.ok(advancedStart >= 0, "Each provider needs its own Advanced disclosure");
for (const id of ["agentLlmRegisteredProviderId", "agentLlmProviderApiKeyEnv", "agentLlmProviderBaseUrlEnv", "agentLlmProviderWireApi", "agentLlmProviderDisableStreamOptions"]) {
  assert.ok(advancedSettings.includes(`id="${id}"`), `${id} must be inside Provider Advanced`);
}
for (const id of [
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
]) {
  assert.ok(modelDialog.includes(`id="${id}"`), `${id} must be inside the dedicated model editor`);
}
assert.match(advancedSettings, /<summary>Provider Advanced<\/summary>/);
assert.match(modelDialog, /<summary>Model capabilities and evidence<\/summary>/);
assert.ok(html.indexOf('id="agentLlmModelList"') < advancedStart, "The model chooser must stay in the primary flow");

const modelSettings = js.slice(js.indexOf("function renderAgentLlmDialog()"), js.indexOf("\nfunction openAgentLlmDialog"));
assert.doesNotMatch(modelSettings, /settings\.user_environ\.path|provider\.kind\}.*credential/);
assert.doesNotMatch(modelSettings, /settings\.validation_error \|\||result\.message \|\|/);
assert.match(modelSettings, /providerReadiness\(provider, settings\)/);
assert.match(modelSettings, /createAgentConnectionModelCard\(/);
const connectionModelCard = js.slice(js.indexOf("function createAgentConnectionModelCard"), js.indexOf("\nfunction providerConnectionLabel"));
assert.match(connectionModelCard, /modelConnectionLabel\(model\)/);
const modelSettingActions = js.slice(js.indexOf("async function saveAgentProvider()"), js.indexOf("\nfunction syncAgentPolling"));
assert.doesNotMatch(modelSettingActions, /toast\(String\(error\)|toast\(`[^`]*\$\{error\}/);
assert.doesNotMatch(modelSettingActions, /toast\(`Opened \$\{info\.path\}|Copied \$\{envName\}/);

assert.doesNotMatch(js, /toast\(String\((?:error|err|failure)\)/);
assert.doesNotMatch(js, /toast\(`[^`]*\$\{(?:error|err|failure)\}/);

const gitReview = js.slice(js.indexOf("function renderGitReview()"), js.indexOf("\nfunction renderConflictBanner"));
assert.match(gitReview, /userFacingError\(state\.gitReview\.error/);
assert.doesNotMatch(gitReview, /textContent = state\.gitReview\.error|Git review unavailable: \$\{error\}/);

const packageInventory = js.slice(js.indexOf("function renderPackageList()"), js.indexOf("\nfunction abbreviateLibrary"));
assert.match(packageInventory, /userFacingError\(data\.error/);
assert.doesNotMatch(packageInventory, /meta\.textContent = data\?\.error\s*(?:\|\||;)/);

const agentReviewDetail = js.slice(js.indexOf("async function loadAgentReviewRunDetail"), js.indexOf("\nfunction agentReviewEvidence"));
assert.match(agentReviewDetail, /reportUiFailure\("load Agent run review"/);
assert.doesNotMatch(agentReviewDetail, /state\.agentReviewRunError = String\(error\)/);

const agentRuntimeRetry = js.slice(js.indexOf('$("#agentRuntimeRetryButton").addEventListener'), js.indexOf('$("#agentCancelButton").addEventListener'));
assert.match(agentRuntimeRetry, /userFacingError\(state\.agentRuntime\.error/);
assert.match(agentRuntimeRetry, /reportUiFailure\("retry Agent runtime"/);
assert.doesNotMatch(agentRuntimeRetry, /toast\(state\.agentRuntime\.available \? "Agent runtime is ready\." : state\.agentRuntime\.error/);

const auditedRenderers = [projectSkills, timeline, installedHelp, localHelp, projectReferences, environmentSummary, environmentOperation, dataViewer, evidenceClaims, compare, agentRunReview, modelSettings].join("\n");
assert.doesNotMatch(auditedRenderers, /\.textContent\s*=\s*[^;\n]*(?:request_id|run_id|artifact_id|snapshot_id)/);
assert.doesNotMatch(auditedRenderers, /(?:textContent|title)\s*=\s*[^;\n]*arguments_json|JSON\.stringify\(/);
assert.doesNotMatch(auditedRenderers, /(?:textContent|title)\s*=\s*String\((?:error|failure)\)/);

console.log("Human-facing information projection contract checks passed.");

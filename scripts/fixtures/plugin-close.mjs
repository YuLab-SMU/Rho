import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";

export async function checkViewClose(sdk) {
  const channel = new MessageChannel();
  const client = new sdk.PluginViewClient(channel.port1, { protocol_version: 1, connection: "connection",
    features: ["view_close_v1", "external_links_v1", "resource_download_v1"], view: { view: "view", state: { text: "old" }, state_version: 0 } });
  let phase = { phase: "open" }, version = 0, sequence = 0, state = { text: "old" };
  const requests = [];
  channel.port2.on("message", message => {
    const body = message.body; requests.push(body);
    let result = { view: "view", state_version: version, close: phase };
    if (body.type === "set_state") {
      assert.equal(body.expected_version, version); version++; state = body.state;
      result = { status: "succeeded", output: { view: "view", state_version: version, state } };
    }
    channel.port2.postMessage({ protocol_version: 1, connection: "connection", view: "view", sequence: ++sequence, request: message.request, ok: true, result });
  });
  let flushes = 0, resumed = 0, fail = false;
  let release;
  let saving = new Promise(resolve => { release = resolve; });
  const cooperation = await client.installCloseHandler({
    async flush() { flushes++; await saving; if (fail) throw new Error("Storage unavailable 中文"); await client.setState({ text: "latest 中文" }); },
    resume() { resumed++; },
  });
  try {
    await assert.rejects(client.installCloseHandler({ async flush() {} }), /already/);
    phase = { phase: "requested", operation: "close-1" };
    const observing = cooperation.observe();
    assert.equal(cooperation.observe(), observing, "concurrent observations join the original attempt");
    await new Promise(resolve => {
      if (cooperation.getSnapshot().preparing) return resolve();
      const stop = cooperation.subscribe(() => { if (cooperation.getSnapshot().preparing) { stop(); resolve(); } });
    });
    assert.equal(requests.filter(r => r.type === "prepare_close").length, 0);
    await assert.rejects(client.downloadResource({bytes:1}, "plot.png"), /closure is preparing/);
    await assert.rejects(client.openExternal("https://example.org/"), /closure is preparing/);
    await assert.rejects(client.invoke({ id: "fixture.run", version: 1 }, {}), /closure is preparing/);
    await assert.rejects(client.control({ id: "fixture.answer", version: 1 }, {}), /closure is preparing/);
    await assert.rejects(client.cancel("accepted-work"), /closure is preparing/);
    await client.operation("accepted-work"); // Read-only recovery remains available.
    release(); await observing;
    const prepared = requests.filter(r => r.type === "prepare_close");
    assert.equal(flushes, 1); assert.equal(prepared.length, 1);
    assert.equal(prepared[0].operation, "close-1"); assert.equal(prepared[0].state_version, 1);
    assert.equal(prepared[0].renderer, requests[0].renderer);
    assert.deepEqual(state, { text: "latest 中文" });
    await cooperation.observe(); assert.equal(flushes, 1);
    phase = { phase: "open" }; await cooperation.observe();
    assert.equal(resumed, 1); assert.equal(cooperation.getSnapshot().preparing, false);
    fail = true; phase = { phase: "requested", operation: "close-2" };
    await cooperation.observe();
    assert.equal(requests.at(-1).type, "refuse_close"); assert.equal(requests.at(-1).operation, "close-2");
    assert.match(requests.at(-1).reason, /Storage unavailable 中文/);
    assert.equal(requests.filter(r => r.type === "prepare_close").length, 1);
    phase = { phase: "open" }; await cooperation.observe();
    assert.equal(resumed, 2); assert.match(cooperation.getSnapshot().error, /Storage unavailable/);
    // Disposal during a slow flush must never manufacture an acknowledgement.
    fail = false; saving = new Promise(resolve => { release = resolve; });
    phase = { phase: "requested", operation: "close-3" };
    const pending = cooperation.observe();
    await new Promise(resolve => {
      const stop = cooperation.subscribe(() => { if (cooperation.getSnapshot().operation === "close-3") { stop(); resolve(); } });
    });
    client.dispose(); release(); await pending;
    assert.equal(requests.some(r => r.type === "prepare_close" && r.operation === "close-3"), false);
    assert.equal(requests.some(r => r.type === "cancel"), false);
  } finally { client.dispose(); channel.port2.close(); }

  let lostPhase = { phase: "requested", operation: "lost-ack-close" };
  const uncertainCalls = [];
  const uncertain = new sdk.ViewCloseCooperation({ view: "lost-ack", version: () => 9, stateSettled: async () => {},
    request: async body => {
      uncertainCalls.push(body);
      if (body.type === "prepare_close") throw new Error("Reply lost after possible commit");
      return { view: "lost-ack", state_version: 9, close: lostPhase };
    },
  }, { async flush() {} });
  try {
    await uncertain.start(); await uncertain.observe();
    assert.match(uncertain.getSnapshot().error, /unconfirmed/);
    assert.equal(uncertainCalls.some(body => body.type === "refuse_close"), false, "lost acknowledgement is not a flush refusal");
    assert.equal(uncertain.getSnapshot().preparing, true);
    lostPhase = { phase: "open" }; await uncertain.observe();
    assert.equal(uncertain.getSnapshot().preparing, false);
  } finally { uncertain.dispose(); }

  // A synthetic composition event checks the guard only, not native IME support.
  const previous = globalThis.document;
  const document = new EventTarget(); document.body = { inert: false }; document.activeElement = null;
  globalThis.document = document;
  const priorElement = globalThis.HTMLElement; globalThis.HTMLElement = class {};
  let didFlush = false; const messages = [];
  let registered;
  const registration = new Promise(resolve => { registered = resolve; });
  const ime = new sdk.ViewCloseCooperation({ view: "ime", version: () => 0, stateSettled: async () => {},
    request: async body => { messages.push(body); if (body.type === "register_close_handler") await registration; return { view: "ime", state_version: 0, close: { phase: "requested", operation: "ime-close" } }; },
  }, { async flush() { didFlush = true; } });
  try {
    const starting = ime.start(); document.dispatchEvent(new Event("compositionstart")); registered(); await starting; await ime.observe();
    assert.equal(didFlush, false); assert.equal(messages.at(-1).type, "refuse_close");
    assert.equal(document.body.inert, false, "a composing editor keeps its active input surface");
    assert.match(messages.at(-1).reason, /composing/);
  } finally { ime.dispose(); globalThis.document = previous; globalThis.HTMLElement = priorElement; }
  console.log("View close cooperation verifies acknowledged draft capture, exact Operation/version, action fencing, refusal/resume, disposal and composition guard.");
}

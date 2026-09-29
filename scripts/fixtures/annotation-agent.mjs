// The Agent, annotation provider, Rig driver and Host are real. Only the model
// HTTP peer is deterministic; this does not assess a third-party model.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function annotationAgent({agent, notes, context, notePreview, port, query, invoke, binding, pluginQuery}) {
  const requests = [], errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer disposable-annotation-model-key');
      let input = '';
      for await (const bytes of request) {
        input += bytes;
        assert.ok(Buffer.byteLength(input) <= 262144, 'Bounded model input');
      }
      const body = JSON.parse(input);
      assert.equal(body.stream, true);
      const messages = JSON.stringify(body.messages);
      assert.ok(messages.includes('Check the original 🧬 result'));
      assert.ok(messages.includes('Current source status: unknown'));
      assert.ok(messages.includes(context.data.source.source_version));
      requests.push(body);
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({id: 'annotation-model-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta, finish_reason}]})}\n\n`;
      response.writeHead(200, {'Content-Type': 'text/event-stream'}).end(
        chunk({role: 'assistant'}, null) +
        chunk({content: 'Reviewed the frozen annotation; current source status remains unknown.'}, null) +
        chunk({}, 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500).end('Model fixture rejected the request');
    }
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const key = id => ({id, version: 1});
    const agentInvoke = async (id, args) => invoke(id, {binding: await binding(agent, id), arguments: args});
    const agentQuery = (id, args) => pluginQuery(agent, id, args);
    const credential = await port('control', {capability: key('agent.model.key.store'), arguments: {
      binding: await binding(agent, 'agent.model.key.store'),
      arguments: {request_id: 'annotation-fixture-key', value: 'disposable-annotation-model-key'},
    }});
    const settings = (await agentInvoke('agent.model.configure', {version: 0, enabled: true, connection: {
      protocol: 'openai_completions', base_url: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', credential,
    }})).output;
    const created = (await agentInvoke('agent.model.create', {conversation_id: 'annotation-reader', profile: 'project'})).output;
    const selection = {source: 'plugin', label: context.item.title, reference: notePreview.reference, inclusion: JSON.stringify(notePreview.inclusion)};
    const text = 'Review this exact frozen note and distinguish it from the current source.';
    const saved = (await agentInvoke('agent.model.draft', {conversation_id: 'annotation-reader', draft_version: created.draft_version,
      content: {text, context: [selection], assets: []}, grant: null})).output;
    const input = {request_id: 'annotation-send-original', conversation_id: 'annotation-reader', conversation_version: saved.version,
      model_settings_version: settings.version, text, sources: [selection]};
    const original = await agentInvoke('agent.model.run', input);
    const run = original.output;
    assert.equal(run.state, 'completed', JSON.stringify(run));
    assert.equal(requests.length, 1); assert.deepEqual(errors, []);
    assert.equal(run.context.sources.length, 1);
    assert.equal(run.context.sources[0].text, context.text);
    assert.deepEqual(run.context.sources[0].selection, selection);
    assert.deepEqual(run.context.sources[0].native_data, context.data);
    const conversation = await agentQuery('agent.model.conversation', {conversation_id: 'annotation-reader'});
    assert.deepEqual(conversation.draft_content, {text: '', context: [], assets: []});
    return {
      close,
      report: {model_peer: 'local deterministic streaming HTTP fixture', original_run: run.run_id,
        original_host_operation: original.operation.operation_id, exact_annotation: notePreview.reference.selector,
        captured_context: run.context, source_replayed: null},
      async afterRestart() {
        assert.equal((await query('plugins.instance', {instance: notes})).instance.state, 'suspended');
        const state = await query('plugins.instance', {instance: agent});
        assert.equal(state.instance.state, 'suspended');
        const resumed = (await invoke('plugins.resume', {instance: agent, suspension: state.instance.suspension})).output.instance;
        assert.deepEqual(resumed.identity, agent);
        const retained = await agentQuery('agent.model.run.get', {run_id: run.run_id});
        assert.deepEqual(retained.context, run.context);
        const replay = (await agentInvoke('agent.model.run', input)).output;
        assert.equal(replay.run_id, run.run_id);
        assert.deepEqual(replay.context, run.context);
        assert.equal(requests.length, 1, 'Original retry cannot call the model again');
        assert.deepEqual(errors, []);
        assert.equal((await query('plugins.instance', {instance: notes})).instance.state, 'suspended', 'Retained Agent context does not resume its source');
        this.report.recovered_same_instance = true;
        this.report.source_replayed = false;
        this.report.model_requests = requests.length;
      },
    };
  } catch (error) { await close(); throw error; }
}

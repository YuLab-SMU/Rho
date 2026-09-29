import assert from 'node:assert/strict';

export async function checkManagerRestart({ Manager, canResume, operationRequestId }) {
  const identity = { instance: 'retained-r', plugin: 'org.rho.r', revision: 'sha256:' + 'a'.repeat(64), artifact: 'sha256:' + 'b'.repeat(64) };
  const original = { instance: { identity, project: 'project', principal: 'owner', alias: 'r', purpose: 'runtime',
    configuration: { example: 'retained' }, state: 'suspended', suspension: 'suspension-one', diagnostic: null },
    observed_in_this_host: false, process_id: null, retained_calls: null, pending_messages: null, stderr: null };
  function fixture() {
    let saved = null, loseReply = false, rejectSave = false;
    const calls = [], records = [];
    const client = {
      view: { view: 'manager-view', window: 'window', project: 'project', principal: 'owner' },
      async setState(state) { saved = structuredClone(state); if (rejectSave) throw Error('State reply lost'); },
      async invoke(capability, args, options) {
        assert.deepEqual(saved.pending.intent.arguments, args, 'Recovery intent is saved before dispatch');
        calls.push(structuredClone({ capability, args, request: options.requestId }));
        assert.equal(capability.id, 'plugins.resume', 'Restore cannot activate, reconnect views or run science');
        const request = await operationRequestId(this.view.view, options.requestId);
        let record = records.find(item => item.operation.client_request_id === request);
        if (!record) {
          const resumed = structuredClone(original);
          resumed.observed_in_this_host = true; resumed.instance.state = 'active'; delete resumed.instance.suspension;
          record = { operation: { operation_id: 'resume-' + records.length, caller: { kind: 'plugin', id: this.view.view },
            client_request_id: request, capability, normalized_arguments: structuredClone(args), preconditions: [] },
            status: 'succeeded', outcome: 'succeeded', output: resumed, error: null };
          records.push(record);
        }
        if (loseReply) { loseReply = false; throw Error('Resume reply lost'); }
        return structuredClone(record);
      },
      async query(capability, args) {
        assert.equal(capability.id, 'operation.list_recent');
        return { status: 'ready', data: { operations: records.filter(item => item.operation.client_request_id === args.client_request_id)
          .map(item => ({ operation_id: item.operation.operation_id })) } };
      },
      async operation(id) { return structuredClone(records.find(item => item.operation.operation_id === id)); },
    };
    return { calls, records, client, saved: () => structuredClone(saved), lose: () => { loseReply = true; }, failSave: () => { rejectSave = true; } };
  }
  assert.equal(canResume(original), true);
  for (const state of ['active', 'preparing', 'draining', 'suspending', 'released', 'failed', 'disconnected', 'cleanup_failed']) {
    const f = fixture(), manager = new Manager(f.client), observation = structuredClone(original);
    observation.instance.state = state;
    await assert.rejects(manager.resume(observation), /confirmed suspended runtime/); assert.equal(f.calls.length, 0);
  }
  for (const mutate of [value => delete value.instance.suspension, value => { value.instance.purpose = 'fixture_preview'; }]) {
    const f = fixture(), observation = structuredClone(original); mutate(observation);
    await assert.rejects(new Manager(f.client).resume(observation), /confirmed suspended runtime/); assert.equal(f.calls.length, 0);
  }
  {
    const f = fixture(), manager = new Manager(f.client);
    const result = await manager.resume(original);
    assert.deepEqual(result.instance.identity, identity); assert.equal(manager.state.pending, null);
    assert.deepEqual(f.calls[0].args, { instance: identity, suspension: 'suspension-one' });
  }
  {
    const f = fixture(), manager = new Manager(f.client); f.lose();
    await assert.rejects(manager.resume(original), /Resume reply lost/);
    const retained = f.saved(); const reopened = new Manager(f.client, retained);
    assert.equal(f.calls.length, 1, 'Constructing the restored manager is read-only');
    await reopened.recover();
    assert.equal(f.calls.length, 1, 'Inspecting recovery cannot perform the next step');
    assert.equal(reopened.state.pending, null);
  }
  {
    const f = fixture(), manager = new Manager(f.client); f.lose();
    await assert.rejects(manager.resume(original), /Resume reply lost/);
    const retained = f.saved(); const reopened = new Manager(f.client, retained);
    await reopened.dispatch();
    assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.records.length, 1);
  }
  for (const mutate of [
    output => { output.instance.identity = { ...identity, instance: 'replacement' }; },
    output => { output.instance.project = 'another-project'; },
    output => { output.instance.principal = 'another-owner'; },
    output => { output.instance.state = 'suspended'; },
    output => { output.observed_in_this_host = false; },
  ]) {
    const f = fixture(), manager = new Manager(f.client); f.lose();
    await assert.rejects(manager.resume(original), /Resume reply lost/);
    mutate(f.records[0].output);
    await assert.rejects(new Manager(f.client, f.saved()).recover(), /different or unavailable instance/);
    assert.ok(f.saved().pending); assert.equal(f.calls.length, 1);
  }
  {
    const f = fixture(); f.failSave();
    await assert.rejects(new Manager(f.client).resume(original), /State reply lost/);
    assert.equal(f.calls.length, 0);
  }
  console.log('Manager instance restore: confirmed suspensions, original identity, lost replies, explicit retry and no automatic continuation passed.');
}

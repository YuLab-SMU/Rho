import assert from 'node:assert/strict';
import { RhoClient } from '../dist/client.js';
import { validateResponse, validateErrorEnvelope, responseProblems, errorProblems, validateEvent, eventProblems } from '../dist/contract-runtime.js';

// The test boundary validates what the service actually sends against the contract it
// publishes, using the same validators as the service. A response or event that
// drifts from its schema fails here instead of being discovered by a consumer later.
export class CheckedClient extends RhoClient {
  async call(method, input) {
    let value;
    try { value = await super.call(method, input); }
    catch (e) {
      if (e.error) assert.ok(validateErrorEnvelope({ apiVersion: '2.0', ok: false, error: e.error }), method + ' error: ' + JSON.stringify(errorProblems()));
      throw e;
    }
    assert.ok(validateResponse(method, value), method + ': ' + JSON.stringify(responseProblems(method)));
    return value;
  }
  // Events are part of the public contract too. Decode the SSE frames the service
  // writes and validate each data object as a published event.
  async *observed(projectId, after = 0, signal) {
    const body = await this.events(projectId, after, signal);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('');
        if (!data) continue;
        const event = JSON.parse(data);
        assert.ok(validateEvent(event), 'event: ' + JSON.stringify(eventProblems()));
        yield event;
      }
    }
  }
}

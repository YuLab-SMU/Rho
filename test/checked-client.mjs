import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { RhoClient } from '../dist/client.js';
import { responses, errorEnvelope } from '../dist/protocol.js';
const ajv = new Ajv({ strict: false, allowUnionTypes: true, allErrors: true });
const validators = Object.fromEntries(Object.entries(responses).map(([name, schema]) => [name, ajv.compile(schema)]));
const error = ajv.compile(errorEnvelope);
export class CheckedClient extends RhoClient {
  async call(method, input) {
    let value;
    try { value = await super.call(method, input); }
    catch (e) { if (e.error) assert.ok(error({ apiVersion: '1.0', ok: false, error: e.error }), JSON.stringify(error.errors)); throw e; }
    const valid = validators[method]; assert.ok(valid, 'Missing response schema for ' + method);
    assert.ok(valid(value), method + ': ' + JSON.stringify(valid.errors)); return value;
  }
}

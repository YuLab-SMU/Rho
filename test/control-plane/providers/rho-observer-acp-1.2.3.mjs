#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    emit({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "1",
        providerVersion: "1.2.3",
        capabilities: ["workspace.inspect", "workspace.inspect_object", "snapshot.read", "history.errors"],
      },
    });
    continue;
  }
  if (request.method === "session/prompt") {
    emit({ jsonrpc: "2.0", method: "session/update", params: { updateType: "message_delta", cursor: 0, text: "Inspecting admitted revision 843" } });
    emit({ jsonrpc: "2.0", method: "session/update", params: { updateType: "tool_request", tool: "inspect_workspace", callId: "inspect_live", arguments: { query: "objects" } } });
    emit({ jsonrpc: "2.0", method: "session/update", params: { updateType: "terminal", outcome: "completed" } });
    continue;
  }
  if (request.method === "session/cancel" || request.method === "session/close") {
    emit({ jsonrpc: "2.0", id: request.id, result: { closed: true } });
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

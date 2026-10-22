import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, canonical, confined, digest, now, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import type { Project } from './state.js';

// Assignment metadata only. The existing service project lease/serializer owns
// writes; no execution scheduler or new project isolation boundary is created.
export class TaskRouting {
  constructor(public project: Project, public maxReceipts = 256, public maxBytes = 32 * 1024 * 1024) {}
  private async file() { await stateDirectory(this.project.root, '.rho/rho'); return confined(this.project.root, '.rho/rho/task-routing.json', true); }
  private async state() {
    const file = await this.file();
    try { requireThat((await fs.stat(file)).size <= this.maxBytes, 'limit', 'Task routing exceeds maxRetainedMetadataBytes.'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const state = await readJson<any>(file, { current: null, receipts: [] });
    requireThat(Array.isArray(state.receipts) && (state.current === null || state.current.projectId === this.project.id), 'storage', 'Task routing is not readable.');
    requireThat(state.receipts.length <= this.maxReceipts, 'limit', 'Task routing receipt history exceeds maxReceipts.');
    return state;
  }
  async read() { return (await this.state()).current; }
  async feedbackInitialized() { const state = await this.state(); return !!state.feedback && state.feedback.taskId === state.current?.taskId; }
  async feedbackConfiguration() { return (await this.state()).feedback ?? null; }
  async markFeedbackInitialized(configuration: any = {}) {
    const state = await this.state();
    requireThat(state.current, 'condition', 'Assign the original task before selecting feedback.');
    if (state.feedback) { requireThat(state.feedback.taskId === state.current.taskId && Object.entries(configuration).every(([key, value]) => canonical(state.feedback[key]) === canonical(value)), 'conflict', 'Feedback activation belongs to a different task or draft configuration.'); return; }
    const next = { ...state, feedback: { taskId: state.current.taskId, profile: 'rho.feedback/1', at: now(), ...configuration } };
    requireThat(Buffer.byteLength(JSON.stringify(next) + '\n') <= this.maxBytes, 'limit', 'Routing metadata is full; feedback selection is not acknowledged.');
    await atomicJson(await this.file(), next);
  }
  async put(body: any, author: string, bindings: any[]) {
    const state = await this.state(), requestDigest = digest(canonical({ body, author }));
    const old = state.receipts.find((x: any) => x.changeId === body.changeId);
    if (old) { requireThat(old.requestDigest === requestDigest, 'conflict', 'Routing changeId names different content or author.'); return { current: state.current, receipt: old }; }
    requireThat((state.current?.version ?? 0) === body.expectedVersion, 'stale', 'Task routing version changed.');
    requireThat(!state.current || state.current.taskId === body.taskId, 'condition', 'This profile supports one task per project; select another project.');
    requireThat(body.participants.filter((p: any) => p.role === 'business').length === 1 && body.participants.filter((p: any) => p.role === 'presentation').length <= 1, 'condition', 'This profile selects one business and at most one presentation binding per project/task.');
    requireThat(new Set(body.participants.map((x: any) => x.bindingId)).size === body.participants.length, 'invalid', 'Task participants must be unique.');
    for (const participant of body.participants) {
      const binding = bindings.find(x => x.id === participant.bindingId);
      requireThat(binding?.projectId === this.project.id && binding.attachment?.taskId === body.taskId && binding.attachment.role === participant.role, 'scope', 'Participant is not attached to this project/task and role.');
    }
    requireThat(body.feedbackOwnerBindingId === null || body.participants.some((x: any) => x.bindingId === body.feedbackOwnerBindingId && x.role === 'business'), 'scope', 'Feedback owner must be the assigned business binding.');
    requireThat(body.presenterBindingId === null ? !body.participants.some((p: any) => p.role === 'presentation') : body.participants.some((p: any) => p.bindingId === body.presenterBindingId && p.role === 'presentation'), 'scope', 'Presenter must be the assigned presentation participant.');
    const changedPresenter = state.current?.presenter?.bindingId !== body.presenterBindingId;
    const generation = (state.presenterGeneration ?? state.current?.presenter?.generation ?? 0) + (body.presenterBindingId && changedPresenter ? 1 : 0);
    const presenter = body.presenterBindingId ? { bindingId: body.presenterBindingId, generation } : null;
    const current = { projectId: this.project.id, taskId: body.taskId, version: (state.current?.version ?? 0) + 1, compositionId: body.compositionId, participants: body.participants, feedbackOwnerBindingId: body.feedbackOwnerBindingId, presenter, policyRef: body.policyRef };
    const receipt = { changeId: body.changeId, requestDigest, author, version: current.version, at: now() };
    const next = { ...state, presenterGeneration: generation, current, receipts: [...state.receipts, receipt].slice(-this.maxReceipts) };
    requireThat(Buffer.byteLength(JSON.stringify(next) + '\n') <= this.maxBytes, 'limit', 'Routing storage is full; the current assignment is preserved.');
    await atomicJson(await this.file(), next);
    return { current, receipt };
  }
}

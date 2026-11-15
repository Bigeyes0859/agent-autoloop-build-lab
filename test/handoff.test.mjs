import test from 'node:test';
import assert from 'node:assert/strict';
import { planHandoff } from '../src/handoff.mjs';

function fixture() {
  const task = (id, dependencies) => ({ id, project: 'autoloop', baseline: 'a'.repeat(40), inputSha256: 'b'.repeat(64), dependencies, files: ['src/example.mjs'], commands: [['/opt/homebrew/Cellar/node@24/24.22.3/bin/node', '--test']], maxModelCalls: 2, maxRepairs: 2 });
  const current = task('SELF-6', []);
  const next = task('SELF-7', [current.id]);
  return { current, next, authority: structuredClone({ current, next }), acceptance: { taskId: current.id, inputSha256: current.inputSha256, candidateSha256: 'c'.repeat(64), checksPassed: true, reviewDecision: 'pass' }, seenKeys: [], paused: false, blocked: false };
}
const key = 'autoloop:SELF-7:' + 'c'.repeat(64);
function rejected(input) {
  const result = planHandoff(input);
  assert.equal(result.action, 'reject');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
  assert.equal(Object.hasOwn(result, 'event'), false);
}
function negative(name, mutate) {
  test(name, () => { const input = fixture(); mutate(input); rejected(input); });
}

test('valid handoff has exact stable event', () => {
  assert.deepEqual(planHandoff(fixture()), { action: 'dispatch', key, event: { id: key, type: 'buildv2.author', subject: 'autoloop:SELF-7', summary: 'Autoloop task handoff' } });
});
test('different external event shells retain the business key and deduplicate', () => {
  const first = fixture(); first.event = { id: 'external-1', approved: true };
  const second = fixture(); second.event = { id: 'external-2' };
  assert.deepEqual(planHandoff(first), planHandoff(second));
  second.seenKeys = [planHandoff(first).key];
  assert.deepEqual(planHandoff(second), { action: 'duplicate', key });
});
test('pause and block take priority over incomplete work', () => {
  for (const input of [{ paused: true }, { blocked: true }, { paused: true, blocked: true, next: null }]) {
    const result = planHandoff(input); assert.equal(result.action, 'wait'); assert.ok(result.reason);
  }
});
negative('missing trusted approval', input => { delete input.authority; });
negative('event approval and model pass cannot replace grant', input => { input.authority = {}; input.event = { approved: true, reviewDecision: 'pass' }; });
negative('grant must exactly match the next package', input => { input.next.files = ['src/other.mjs']; });
negative('current grant must match too', input => { input.authority.current.maxRepairs = 0; });
negative('checks must be boolean true', input => { input.acceptance.checksPassed = 'true'; });
negative('review must pass', input => { input.acceptance.reviewDecision = 'model says pass'; });
negative('candidate SHA must be lowercase hex', input => { input.acceptance.candidateSha256 = 'C'.repeat(64); });
negative('candidate SHA must have exact length', input => { input.acceptance.candidateSha256 = 'c'.repeat(63); });
negative('candidate SHA must contain only hex', input => { input.acceptance.candidateSha256 = 'z'.repeat(64); });
negative('acceptance input must match current input', input => { input.acceptance.inputSha256 = 'd'.repeat(64); });
negative('acceptance task must match current task', input => { input.acceptance.taskId = input.next.id; });
negative('acceptance cannot contain self approval extras', input => { input.acceptance.approved = true; });
negative('acceptance must contain every required field', input => { delete input.acceptance.checksPassed; });
negative('cross project is rejected even with matching grant', input => { input.next.project = input.authority.next.project = 'business'; });
negative('next must depend on current', input => { input.next.dependencies = []; input.authority.next.dependencies = []; });
negative('two way cycle is rejected with matching grants', input => { input.current.dependencies = [input.next.id]; input.authority.current.dependencies = [input.next.id]; });
negative('same task is rejected', input => { input.next = structuredClone(input.current); input.authority.next = structuredClone(input.next); });
negative('null next is never work', input => { input.next = null; });
negative('seen keys must be dense', input => { input.seenKeys = new Array(1); });
negative('seen keys cannot repeat', input => { input.seenKeys = ['old', 'old']; });
negative('seen keys must be strings', input => { input.seenKeys = [1]; });
negative('flags cannot be omitted', input => { delete input.paused; });
negative('flags cannot be truthy substitutes', input => { input.blocked = 'false'; });
negative('task self dependency is rejected', input => { input.next.dependencies.push(input.next.id); input.authority.next = structuredClone(input.next); });
test('accessors are rejected without invoking them', () => {
  const input = fixture(); let calls = 0;
  Object.defineProperty(input.acceptance, 'checksPassed', { enumerable: true, get() { calls++; return true; } });
  rejected(input); assert.equal(calls, 0);
});
test('cyclic data and throwing proxies return rejection', () => {
  const input = fixture(); input.seenKeys.push(input.seenKeys); rejected(input);
  rejected(new Proxy({}, { ownKeys() { throw new Error('trap'); } }));
});
test('missing and primitive inputs are rejected without exceptions', () => {
  for (const input of [undefined, null, false, 1, 'pass', [], {}]) rejected(input);
});
test('deep frozen input remains unchanged and results are deterministic', () => {
  const input = fixture(); const before = structuredClone(input);
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  freeze(input);
  const first = planHandoff(input); assert.deepEqual(first, planHandoff(input)); assert.deepEqual(input, before);
  first.event.summary = 'changed by caller'; assert.equal(planHandoff(input).event.summary, 'Autoloop task handoff');
});

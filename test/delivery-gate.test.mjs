import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDelivery } from '../src/delivery-gate.mjs';

const head = 'a'.repeat(40);
const input = { repo: 'Bigeyes0859/agent-autoloop-build-lab', baseSha: 'b'.repeat(40), headSha: head, candidateSha256: 'c'.repeat(64), checksPassed: true, reviewDecision: 'pass', ownerDecision: 'approved' };
const now = Date.parse('2026-11-14T12:00:00Z');
const run = (extra = {}) => ({ id: 2, head_sha: head, event: 'pull_request', status: 'completed', conclusion: 'success', created_at: new Date(now - 60_000).toISOString(), ...extra });
const job = (extra = {}) => ({ name: 'check', status: 'completed', conclusion: 'success', ...extra });
const runsPath = 'actions/workflows/check.yml/runs?head_sha=' + head + '&event=pull_request&per_page=100';
function fixture(runs = [run()], jobs = [job()]) {
  const calls = [];
  return { calls, now: () => now, async api(path, body, method) {
    calls.push({ path, body, method });
    assert.equal(body, undefined);
    assert.equal(method, 'GET');
    if (path === runsPath) return { workflow_runs: structuredClone(runs) };
    assert.match(path, /^actions\/runs\/[1-9][0-9]*\/jobs\?filter=latest&per_page=100$/);
    return { jobs: structuredClone(jobs) };
  } };
}
async function expectState(state, io = fixture(), value = input) {
  const actual = await assessDelivery(value, io);
  assert.equal(actual.state, state);
  assert.equal(actual.canMerge, false);
  assert.equal(actual.canDeploy, false);
  if (state === 'blocked') assert.equal(typeof actual.reason, 'string');
  return actual;
}

test('approved latest same-head pull_request with required job is ready', async () => {
  const io = fixture([run({ id: 1, conclusion: 'failure' }), run()]);
  await expectState('ready', io);
  assert.deepEqual(io.calls.map(c => c.path), [runsPath, 'actions/runs/2/jobs?filter=latest&per_page=100']);
});
test('missing CI waits', () => expectState('waiting_ci', fixture([])));
test('missing required job waits', () => expectState('waiting_ci', fixture([run()], [job({ name: 'lint' })])));
test('no jobs waits', () => expectState('waiting_ci', fixture([run()], [])));
test('successful run contradicting failed job cannot be ready', () => expectState('waiting_ci', fixture([run()], [job({ conclusion: 'failure' })])));
test('failed run fails even with successful job', () => expectState('failed_ci', fixture([run({ conclusion: 'failure' })])));
test('failed matrix member prevents readiness', () => expectState('waiting_ci', fixture([run()], [job({ name: 'check (linux)' }), job({ name: 'check (mac)', conclusion: 'failure' })])));
test('successful matrix members satisfy required job', () => expectState('ready', fixture([run()], [job({ name: 'check (linux)' }), job({ name: 'check (mac)' })])));
test('old head and workflow_dispatch runs are ignored', async () => {
  const io = fixture([run({ id: 9, head_sha: 'd'.repeat(40) }), run({ id: 10, event: 'workflow_dispatch' })]);
  await expectState('waiting_ci', io);
  assert.equal(io.calls.length, 1);
});
test('newest eligible run wins over earlier success', () => expectState('waiting_ci', fixture([run(), run({ id: 3, status: 'in_progress', conclusion: null })], [job({ status: 'in_progress', conclusion: null })])));
test('recent queue waits', () => expectState('waiting_ci', fixture([run({ status: 'queued', conclusion: null })], [])));
test('queue older than ten minutes stalls', () => expectState('stalled_ci', fixture([run({ status: 'queued', conclusion: null, created_at: new Date(now - 600_001).toISOString() })], [])));
test('queue at ten minute boundary waits', () => expectState('waiting_ci', fixture([run({ status: 'waiting', conclusion: null, created_at: new Date(now - 600_000).toISOString() })], [])));
test('pending and rejected never inspect IO', async () => {
  const io = new Proxy({}, { get() { assert.fail('IO accessed'); } });
  await expectState('awaiting_owner', io, { ...input, ownerDecision: 'pending' });
  await expectState('rejected', io, { ...input, ownerDecision: 'rejected' });
});
test('invalid preconditions and exact field set block before IO', async () => {
  const io = new Proxy({}, { get() { assert.fail('IO accessed'); } });
  for (const patch of [{ repo: 'other/repo' }, { baseSha: 'B'.repeat(40) }, { headSha: 'a'.repeat(39) }, { candidateSha256: 'g'.repeat(64) }, { checksPassed: 'true' }, { reviewDecision: 'approved' }, { ownerDecision: undefined }, { ownerDecision: 'yes' }, { extra: true }]) await expectState('blocked', io, { ...input, ...patch });
  const missing = { ...input }; delete missing.ownerDecision;
  await expectState('blocked', io, missing);
  await expectState('blocked', io, null);
});
test('input accessors are rejected without invocation', async () => {
  const value = { ...input };
  Object.defineProperty(value, 'ownerDecision', { enumerable: true, get() { assert.fail('getter invoked'); } });
  await expectState('blocked', null, value);
});
test('request failures block without retry', async () => {
  let calls = 0;
  await expectState('blocked', { async api() { calls++; throw new Error('offline'); } });
  assert.equal(calls, 1);
});
test('malformed workflow responses block', async () => {
  for (const response of [null, {}, { workflow_runs: {} }, { workflow_runs: [run({ id: '../1' })] }, { workflow_runs: [run({ id: 0 })] }, { workflow_runs: [run({ created_at: 'invalid' })] }, { workflow_runs: [run({ status: 'bogus' })] }, { workflow_runs: [run(), run()] }]) await expectState('blocked', { api: async () => response });
});
test('malformed jobs responses block', async () => {
  for (const response of [null, {}, { jobs: {} }, { jobs: [null] }, { jobs: [job({ name: 12 })] }, { jobs: [job({ conclusion: null })] }]) await expectState('blocked', { api: async path => path === runsPath ? { workflow_runs: [run()] } : response });
});
test('response accessors block without execution', () => expectState('blocked', { api: async () => Object.defineProperty({}, 'workflow_runs', { enumerable: true, get() { assert.fail('getter invoked'); } }) }));
test('unsafe IDs never form a jobs request', async () => {
  const io = fixture([run({ id: Number.MAX_SAFE_INTEGER + 1 })]);
  await expectState('blocked', io);
  assert.equal(io.calls.length, 1);
});
test('repeated assessments only issue allowlisted reads and preserve fixture inputs', async () => {
  const runs = [run()]; const jobs = [job()];
  const before = structuredClone({ runs, jobs, input });
  const io = fixture(runs, jobs);
  for (const key of ['merge', 'deliver', 'deploy', 'review', 'wait']) io[key] = () => assert.fail('business side effect');
  await expectState('ready', io); await expectState('ready', io);
  assert.deepEqual({ runs, jobs, input }, before);
  assert.equal(io.calls.length, 4);
  for (const call of io.calls) {
    assert.equal(call.method, 'GET'); assert.equal(call.body, undefined);
    assert.ok([runsPath, 'actions/runs/2/jobs?filter=latest&per_page=100'].includes(call.path));
  }
});

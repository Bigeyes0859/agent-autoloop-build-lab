import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDecision } from '../src/project-scope.mjs';

const registry = () => [
  { id: 'autoloop', mode: 'isolated-build', allowedTasks: ['SELF-9', 'OTHER'] },
  { id: 'moneybuddy', mode: 'read-only', allowedTasks: ['SELF-9', 'G3'] },
  { id: 'hotspot-hub', mode: 'not-started', allowedTasks: ['SELF-9'] },
  { id: 'fishrush', mode: 'paused', allowedTasks: ['SELF-9'] },
];
function request(project = 'autoloop', operation = 'isolated-build', taskId = 'SELF-9') {
  return { project, taskId, operation, grant: { project, taskId, operation, approved: true } };
}
function expectDecision(entries, req, decision = 'deny') {
  const result = projectDecision(entries, req);
  assert.deepEqual(Object.keys(result).sort(), ['decision', 'reason']);
  assert.equal(result.decision, decision);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.trim().length > 0);
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

for (const project of ['autoloop', 'moneybuddy', 'hotspot-hub', 'fishrush']) {
  test(project + ' operation matrix', () => {
    for (const mode of ['isolated-build', 'read-only', 'paused', 'not-started']) {
      for (const operation of ['metadata-read', 'isolated-build', 'remote-write', 'merge', 'deploy']) {
        const entries = registry();
        entries.find(entry => entry.id === project).mode = mode;
        const allowed = (project === 'autoloop' && mode === 'isolated-build' && operation === 'isolated-build') ||
          (project === 'moneybuddy' && mode === 'read-only' && operation === 'metadata-read');
        expectDecision(entries, request(project, operation), allowed ? 'allow' : 'deny');
      }
    }
  });
}
test('registration alone grants nothing', () => {
  const req = request();
  req.grant = null;
  expectDecision(registry(), req);
  delete req.grant;
  expectDecision(registry(), req);
});
test('same task ID cannot reuse another project grant', () => {
  const req = request('moneybuddy', 'metadata-read');
  req.grant.project = 'autoloop';
  expectDecision(registry(), req);
});
test('grant cannot be reused for another task or operation', () => {
  for (const [key, value] of [['taskId', 'OTHER'], ['operation', 'metadata-read']]) {
    const req = request();
    req.grant[key] = value;
    expectDecision(registry(), req);
  }
});
test('MoneyBuddy G3 candidates cannot be delivered or take over A/B work', () => {
  for (const id of ['G3', 'A', 'B']) {
    for (const op of ['isolated-build', 'remote-write', 'merge', 'deploy']) {
      expectDecision(registry(), request('moneybuddy', op, id));
    }
  }
});
test('paused and not-started Autoloop deny even exact grants', () => {
  for (const mode of ['paused', 'not-started']) {
    const entries = registry();
    entries[0].mode = mode;
    expectDecision(entries, request());
  }
});
test('duplicate projects invalidate the entire registry', () => {
  expectDecision([...registry(), registry()[0]], request());
});
test('unknown fields in any schema deny', () => {
  const entries = registry();
  entries[3].extra = true;
  expectDecision(entries, request());
  const req = request();
  req.extra = true;
  expectDecision(registry(), req);
  delete req.extra;
  req.grant.extra = true;
  expectDecision(registry(), req);
});
test('approval must be boolean true', () => {
  for (const approved of [false, 'true', 1, null, undefined]) {
    const req = request();
    req.grant.approved = approved;
    expectDecision(registry(), req);
  }
});
test('missing registration and unlisted tasks deny', () => {
  expectDecision([], request());
  expectDecision(registry().slice(1), request());
  expectDecision(registry(), request('autoloop', 'isolated-build', 'UNLISTED'));
});
test('unknown projects modes and operations deny', () => {
  expectDecision(registry(), request('unknown'));
  expectDecision(registry(), request('autoloop', 'write'));
  for (const [key, value] of [['id', 'unknown'], ['mode', 'approved']]) {
    const entries = registry();
    entries[3][key] = value;
    expectDecision(entries, request());
  }
});
test('task arrays must be dense unique valid IDs', () => {
  for (const tasks of [new Array(1), ['SELF-9', 'SELF-9'], [''], ['lowercase'], [null], ['A/B']]) {
    const entries = registry();
    entries[0].allowedTasks = tasks;
    expectDecision(entries, request());
  }
});
test('malformed top-level values never throw', () => {
  for (const value of [undefined, null, true, 5, 'x', {}, new Date()]) {
    expectDecision(value, request());
    expectDecision(registry(), value);
  }
  expectDecision(new Array(2), request());
});
test('missing fields in registry request and grant deny', () => {
  for (const field of ['id', 'mode', 'allowedTasks']) {
    const entries = registry();
    delete entries[0][field];
    expectDecision(entries, request());
  }
  for (const field of ['project', 'taskId', 'operation', 'grant']) {
    const req = request();
    delete req[field];
    expectDecision(registry(), req);
  }
  for (const field of ['project', 'taskId', 'operation', 'approved']) {
    const req = request();
    delete req.grant[field];
    expectDecision(registry(), req);
  }
});
test('accessors and serialization hooks are never invoked', () => {
  let calls = 0;
  const req = request();
  Object.defineProperty(req, 'project', { enumerable: true, get() { calls++; throw Error('getter'); } });
  expectDecision(registry(), req);
  const hooked = request();
  hooked.toJSON = () => { calls++; return request(); };
  expectDecision(registry(), hooked);
  assert.equal(calls, 0);
});
test('symbols non-enumerable extras and custom prototypes deny', () => {
  for (const key of [Symbol('extra'), 'extra']) {
    const req = request();
    Object.defineProperty(req, key, { value: true });
    expectDecision(registry(), req);
  }
  const req = Object.assign(Object.create({}), request());
  expectDecision(registry(), req);
});
test('cyclic data and throwing proxies deny without escaping exceptions', () => {
  const req = request();
  req.grant = req;
  expectDecision(registry(), req);
  expectDecision(registry(), new Proxy({}, { ownKeys() { throw Error('trap'); } }));
});
test('array extra properties cannot conceal evidence', () => {
  const entries = registry();
  entries.extra = true;
  expectDecision(entries, request());
  const other = registry();
  other[0].allowedTasks.extra = true;
  expectDecision(other, request());
});
test('deep frozen inputs stay unchanged and results are deterministic', () => {
  const entries = freeze(registry());
  const req = freeze(request());
  const before = JSON.stringify([entries, req]);
  const first = expectDecision(entries, req, 'allow');
  assert.deepEqual(projectDecision(entries, req), first);
  assert.equal(JSON.stringify([entries, req]), before);
});
test('independent task events do not contaminate subsequent decisions', () => {
  const entries = registry();
  const first = expectDecision(entries, request(), 'allow');
  const invalid = request('autoloop', 'isolated-build', 'OTHER');
  invalid.grant.taskId = 'SELF-9';
  expectDecision(entries, invalid);
  expectDecision(entries, request('autoloop', 'isolated-build', 'OTHER'), 'allow');
  first.decision = 'deny';
  expectDecision(entries, request(), 'allow');
  expectDecision(entries, request('moneybuddy', 'metadata-read'), 'allow');
});

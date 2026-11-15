const PROJECTS = new Set(['autoloop', 'moneybuddy', 'hotspot-hub', 'fishrush']);
const MODES = new Set(['isolated-build', 'read-only', 'paused', 'not-started']);
const OPERATIONS = new Set(['metadata-read', 'isolated-build', 'remote-write', 'merge', 'deploy']);
const TASK_ID = /^[A-Z][A-Z0-9-]{0,63}$/;

// Snapshot only plain data; never execute accessors or serialization hooks.
function snapshot(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Invalid data');
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) {
    throw new TypeError('Invalid prototype');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const result = array ? [] : Object.create(null);
  ancestors.add(value);
  try {
    if (array && keys.length !== descriptors.length.value + 1) throw new TypeError('Sparse array');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const d = descriptors[key];
      if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) throw new TypeError('Invalid property');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= descriptors.length.value)) throw new TypeError('Invalid index');
      result[key] = snapshot(d.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function exact(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
const taskId = value => typeof value === 'string' && TASK_ID.test(value);
const deny = reason => ({ decision: 'deny', reason });

// Grants must be supplied by the trusted caller; registration alone is no approval.
export function projectDecision(registry, request) {
  try {
    const entries = snapshot(registry);
    const req = snapshot(request);
    if (!Array.isArray(entries)) return deny('Invalid registry');
    const ids = new Set();
    for (const entry of entries) {
      if (!exact(entry, ['id', 'mode', 'allowedTasks']) || !PROJECTS.has(entry.id) ||
          !MODES.has(entry.mode) || ids.has(entry.id) || !Array.isArray(entry.allowedTasks) ||
          !entry.allowedTasks.every(taskId) || new Set(entry.allowedTasks).size !== entry.allowedTasks.length) {
        return deny('Invalid registry entry');
      }
      ids.add(entry.id);
    }
    if (!exact(req, ['project', 'taskId', 'operation', 'grant']) || !PROJECTS.has(req.project) ||
        !taskId(req.taskId) || !OPERATIONS.has(req.operation)) return deny('Invalid request');
    const grant = req.grant;
    if (!exact(grant, ['project', 'taskId', 'operation', 'approved']) || grant.approved !== true ||
        grant.project !== req.project || grant.taskId !== req.taskId || grant.operation !== req.operation) {
      return deny('Missing or mismatched explicit grant');
    }
    if (['remote-write', 'merge', 'deploy'].includes(req.operation)) return deny('Separate object-specific approval required');
    const entry = entries.find(item => item.id === req.project);
    if (!entry || !entry.allowedTasks.includes(req.taskId)) return deny('Project or task is not registered');
    if (req.project === 'autoloop' && entry.mode === 'isolated-build' && req.operation === 'isolated-build') {
      return { decision: 'allow', reason: 'Explicit grant for registered Autoloop isolated build' };
    }
    if (req.project === 'moneybuddy' && entry.mode === 'read-only' && req.operation === 'metadata-read') {
      return { decision: 'allow', reason: 'Explicit grant for registered MoneyBuddy metadata read' };
    }
    return deny('Project mode does not permit this operation');
  } catch {
    return deny('Malformed input');
  }
}

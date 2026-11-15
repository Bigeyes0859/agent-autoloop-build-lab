import { createHash } from 'node:crypto';

const NODE = '/opt/homebrew/Cellar/node@24/24.22.3/bin/node';
const FIELDS = ['id', 'project', 'baseline', 'inputSha256', 'dependencies', 'files', 'commands', 'maxModelCalls', 'maxRepairs'];
const ID = /^[A-Z][A-Z0-9-]{0,63}$/;

// Inspect descriptors so user-defined getters and toJSON are never invoked.
function serialize(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new TypeError('Expected a plain JSON value');
  if (ancestors.has(value)) throw new TypeError('Cyclic JSON value');
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (!array && proto !== Object.prototype && proto !== null) throw new TypeError('Non-plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const d = descriptors[key];
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) {
      throw new TypeError('Only enumerable data properties are supported');
    }
  }
  ancestors.add(value);
  try {
    if (array) {
      const length = descriptors.length.value;
      if (keys.length !== length + 1) throw new TypeError('Sparse array or extra array properties');
      const items = [];
      for (let i = 0; i < length; i++) {
        if (!Object.hasOwn(descriptors, String(i))) throw new TypeError('Sparse array');
        items.push(serialize(descriptors[String(i)].value, ancestors));
      }
      return '[' + items.join(',') + ']';
    }
    return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + serialize(descriptors[key].value, ancestors)).join(',') + '}';
  } finally {
    ancestors.delete(value);
  }
}

export function taskFingerprint(value) {
  return createHash('sha256').update(serialize(value)).digest('hex');
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 &&
    !/[\\\s\x00]/u.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

function inspect(value, label, errors) {
  let encoded;
  try { encoded = serialize(value); }
  catch { errors.push(label + ': expected plain JSON data without accessors, cycles or sparse arrays'); return null; }
  const data = JSON.parse(encoded);
  if (data === null || Array.isArray(data) || typeof data !== 'object') {
    errors.push(label + ': expected an object');
    return null;
  }
  for (const field of FIELDS) {
    if (!Object.hasOwn(data, field)) errors.push(label + ': missing field ' + field);
  }
  for (const field of Object.keys(data)) {
    if (!FIELDS.includes(field)) errors.push(label + ': unknown field ' + field);
  }
  const fail = (field, valid) => { if (!valid) errors.push(label + ': invalid ' + field); };
  fail('id', typeof data.id === 'string' && ID.test(data.id));
  fail('project', data.project === 'autoloop');
  fail('baseline', typeof data.baseline === 'string' && /^[a-f0-9]{40}$/.test(data.baseline));
  fail('inputSha256', typeof data.inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(data.inputSha256));
  fail('dependencies', Array.isArray(data.dependencies) && data.dependencies.every(id => typeof id === 'string' && ID.test(id) && id !== data.id) && new Set(data.dependencies).size === data.dependencies.length);
  fail('files', Array.isArray(data.files) && data.files.length > 0 && data.files.every(validPath) && new Set(data.files).size === data.files.length);
  fail('commands', Array.isArray(data.commands) && data.commands.length > 0 && data.commands.every(command => Array.isArray(command) && command.length > 0 && command.every(arg => typeof arg === 'string') && command[0] === NODE));
  fail('maxModelCalls', Number.isInteger(data.maxModelCalls) && data.maxModelCalls >= 1 && data.maxModelCalls <= 6);
  fail('maxRepairs', Number.isInteger(data.maxRepairs) && data.maxRepairs >= 0 && data.maxRepairs <= 2);
  return { data, encoded };
}

// The caller supplies the trusted grant; equality does not establish its provenance.
export function validateTask(pkg, grant) {
  const errors = [];
  const p = inspect(pkg, 'pkg', errors);
  const g = inspect(grant, 'grant', errors);
  if (p && g) {
    for (const field of FIELDS) {
      if (Object.hasOwn(p.data, field) && Object.hasOwn(g.data, field) && serialize(p.data[field]) !== serialize(g.data[field])) {
        errors.push('grant mismatch: ' + field);
      }
    }
  }
  return { ok: errors.length === 0, errors, fingerprint: errors.length === 0 ? taskFingerprint(pkg) : null };
}

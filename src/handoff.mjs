import { validateTask } from './task-package.mjs';

const ACCEPTANCE = ['taskId', 'inputSha256', 'candidateSha256', 'checksPassed', 'reviewDecision'];
const reject = reason => ({ action: 'reject', reason });

// Copy data descriptors only: never execute accessors or serialization hooks.
function copy(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Invalid data');
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (!array && proto !== Object.prototype && proto !== null) throw new TypeError('Invalid object');
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
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError('Invalid index');
      result[key] = copy(d.value, ancestors);
    }
    if (array) {
      for (let i = 0; i < descriptors.length.value; i++) {
        if (!Object.hasOwn(descriptors, String(i))) throw new TypeError('Sparse array');
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

// Grants are supplied by the trusted caller; this planner cannot prove provenance.
export function planHandoff(input) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return reject('Expected input object');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const flag = name => {
      const d = descriptors[name];
      return d && Object.hasOwn(d, 'value') ? d.value : undefined;
    };
    if (flag('paused') === true) return { action: 'wait', reason: 'Handoff is paused' };
    if (flag('blocked') === true) return { action: 'wait', reason: 'Handoff is blocked' };
    if (flag('paused') !== false || flag('blocked') !== false) return reject('Explicit boolean flags required');
    const data = Object.create(null);
    for (const name of ['current', 'next', 'acceptance', 'authority', 'seenKeys']) {
      const d = descriptors[name];
      if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return reject('Missing data: ' + name);
      data[name] = copy(d.value);
    }
    const { current, next, acceptance, authority, seenKeys } = data;
    if (!authority || !validateTask(current, authority.current).ok || !validateTask(next, authority.next).ok) return reject('Task or trusted grant is invalid');
    if (current.id === next.id || !next.dependencies.includes(current.id) || current.dependencies.includes(next.id)) return reject('Invalid handoff dependencies');
    if (!acceptance || Array.isArray(acceptance) || Object.keys(acceptance).length !== ACCEPTANCE.length || !ACCEPTANCE.every(key => Object.hasOwn(acceptance, key))) return reject('Invalid acceptance fields');
    if (acceptance.taskId !== current.id || acceptance.inputSha256 !== current.inputSha256 || typeof acceptance.candidateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(acceptance.candidateSha256) || acceptance.checksPassed !== true || acceptance.reviewDecision !== 'pass') return reject('Acceptance has not passed for the current task');
    if (!Array.isArray(seenKeys) || !seenKeys.every(key => typeof key === 'string') || new Set(seenKeys).size !== seenKeys.length) return reject('Invalid seen keys');
    const key = 'autoloop:' + next.id + ':' + acceptance.candidateSha256;
    if (seenKeys.includes(key)) return { action: 'duplicate', key };
    return { action: 'dispatch', key, event: { id: key, type: 'buildv2.author', subject: 'autoloop:' + next.id, summary: 'Autoloop task handoff' } };
  } catch {
    return reject('Invalid handoff data');
  }
}

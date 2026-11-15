import { fullCheck } from '../vendor/agent-autoloop/delivery.ts';
import { settings } from '../vendor/agent-autoloop/project.ts';

const REPO = 'Bigeyes0859/agent-autoloop-build-lab';
const FIELDS = ['repo', 'baseSha', 'headSha', 'candidateSha256', 'checksPassed', 'reviewDecision', 'ownerDecision'];
const result = (state, reason) => ({ state, ...(reason ? { reason } : {}), canMerge: false, canDeploy: false });

// Snapshot plain data without invoking accessors or user-defined serialization.
function data(value, seen = new Set()) {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Invalid data');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid object');
  seen.add(value);
  try {
    const out = array ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) throw new Error('Invalid property');
      Object.defineProperty(out, key, { value: data(d.value, seen), enumerable: true, writable: true, configurable: true });
    }
    if (array && (out.length !== value.length || Object.keys(out).length !== value.length)) throw new Error('Invalid array');
    return out;
  } finally { seen.delete(value); }
}

const statuses = new Set(['completed', 'queued', 'waiting', 'pending', 'in_progress', 'requested']);
const conclusions = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']);
function statusRecord(item) {
  if (!item || !statuses.has(item.status) || !(item.conclusion === null || conclusions.has(item.conclusion))) throw new Error('Invalid CI status');
  if (item.status === 'completed' ? item.conclusion === null : item.conclusion !== null) throw new Error('Invalid CI conclusion');
}

export async function assessDelivery(input, io) {
  try {
    const v = data(input);
    if (!v || Array.isArray(v) || Object.keys(v).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(v, key))) return result('blocked', 'Invalid input fields');
    if (v.repo !== REPO || typeof v.baseSha !== 'string' || !/^[a-f0-9]{40}$/.test(v.baseSha) ||
        typeof v.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(v.headSha) ||
        typeof v.candidateSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(v.candidateSha256) ||
        v.checksPassed !== true || v.reviewDecision !== 'pass' || !['pending', 'rejected', 'approved'].includes(v.ownerDecision)) return result('blocked', 'Invalid delivery preconditions');
    if (v.ownerDecision === 'pending') return result('awaiting_owner');
    if (v.ownerDecision === 'rejected') return result('rejected');
    const runsPath = 'actions/workflows/check.yml/runs?head_sha=' + v.headSha + '&event=pull_request&per_page=100';
    const allowedRuns = new Set();
    const wrappedIO = {
      async api(path, body, method) {
        if (body !== undefined || (method !== undefined && method !== 'GET')) throw new Error('Read-only API required');
        const jobsMatch = typeof path === 'string' && /^actions\/runs\/([1-9][0-9]*)\/jobs\?filter=latest&per_page=100$/.exec(path);
        if (path !== runsPath && !(jobsMatch && allowedRuns.has(jobsMatch[1]))) throw new Error('API path denied');
        const response = data(await io.api(path, undefined, 'GET'));
        if (path === runsPath) {
          if (!response || !Array.isArray(response.workflow_runs)) throw new Error('Invalid workflow response');
          const ids = new Set();
          for (const run of response.workflow_runs) {
            statusRecord(run);
            if (!Number.isSafeInteger(run.id) || run.id <= 0 || ids.has(run.id) || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.head_sha) || typeof run.event !== 'string' || !run.event || typeof run.created_at !== 'string' || !Number.isFinite(Date.parse(run.created_at))) throw new Error('Invalid workflow run');
            ids.add(run.id);
            if (run.head_sha === v.headSha && run.event === 'pull_request') allowedRuns.add(String(run.id));
          }
        } else {
          if (!response || !Array.isArray(response.jobs)) throw new Error('Invalid jobs response');
          for (const job of response.jobs) {
            statusRecord(job);
            if (typeof job.name !== 'string' || !job.name) throw new Error('Invalid job');
          }
        }
        return response;
      },
      now() {
        const now = io.now === undefined ? Date.now() : io.now();
        if (!Number.isFinite(now)) throw new Error('Invalid clock');
        return now;
      },
    };
    const config = settings({ repo: REPO, internal: [], check: { workflow: 'check.yml', job: 'check' }, review: { points: 'REVIEW.md' }, ship: { workflow: 'ship.yml' } });
    const state = await fullCheck(v.headSha, config, wrappedIO);
    const mapped = { passed: 'ready', waiting: 'waiting_ci', failed: 'failed_ci', stalled: 'stalled_ci' };
    return Object.hasOwn(mapped, state) ? result(mapped[state]) : result('blocked', 'Invalid CI result');
  } catch {
    return result('blocked', 'Invalid data or CI request failed');
  }
}

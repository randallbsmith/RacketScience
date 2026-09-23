import { mkdir, readFile, open, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const dataDir = resolve(process.env.DATA_DIR || './data');
export function fault(status, code, message) { return Object.assign(new Error(message), { status, code }); }
export async function readState(dir = dataDir) {
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
}
// Atomic directory creation coordinates the API and separate job processes.
// Never steal an old lock: a slow live writer must not lose mutual exclusion.
export async function withLock(fn, dir = dataDir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'state.lock');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw fault(503, 'busy', 'File is busy; try again.');
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await fn(); } finally { await rmdir(lock); }
}
export async function writeState(state, dir = dataDir) {
  const temp = join(dir, `.state-${randomUUID()}.tmp`);
  const f = await open(temp, 'wx', 0o600);
  try {
    await f.writeFile(JSON.stringify(state, null, 2) + '\n');
    await f.sync();
  } finally { await f.close(); }
  try { await rename(temp, join(dir, 'state.json')); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function transaction(fn, dir = dataDir) {
  return withLock(async () => {
    const state = await readState(dir);
    const result = await fn(state);
    await writeState(state, dir);
    return result;
  }, dir);
}
const limits = { name: 120, comments: 2000, email: 254, alternateEmail: 1000, phone: 100, notes: 10000 };
export async function patchField(patch, dir = dataDir) {
  if (!patch || typeof patch !== 'object') throw fault(400, 'invalid', 'Invalid change.');
  const { gameDate, playerId, field, value, previous } = patch;
  if (field !== 'attendance' && !Object.hasOwn(limits, field)) throw fault(400, 'invalid', 'Unknown field.');
  if (field === 'attendance' ? ![null, 'yes', 'no', 'maybe'].includes(value)
    : typeof value !== 'string' || value.length > limits[field]) throw fault(400, 'invalid', 'Invalid field value.');
  return transaction(state => {
    if (gameDate !== state.gameDate) throw fault(409, 'stale_game', 'The next game has started. Reload before editing.');
    const target = field === 'notes' && !playerId ? state : state.players.find(p => p.id === playerId);
    if (!target || (field === 'notes' && target !== state)) throw fault(400, 'invalid', 'Unknown player.');
    if (target[field] !== previous) throw fault(409, 'conflict', 'Someone changed this field. Reload to review their change.');
    target[field] = value;
    return { value, gameDate: state.gameDate };
  }, dir);
}

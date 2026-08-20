// Local driver — the whole API against localStorage, single browser only.
// Exists so the app is demo-able (and testable) without a Supabase project,
// and so an unconfigured deploy degrades to something usable rather than a
// stack trace. Mirrors the SQL functions in supabase-schema.sql exactly.

const KEY = 'shmaybe.local.v1';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

const slugify = () => Array.from({ length: 12 },
  () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

function db() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { plans: {} }; }
  catch { return { plans: {} }; }
}
function write(d) { localStorage.setItem(KEY, JSON.stringify(d)); }

function plan(d, slug) {
  const p = d.plans[slug];
  if (!p) throw new Error('No such plan');
  return p;
}
function auth(d, slug, token) {
  const p = plan(d, slug);
  const me = p.participants.find(x => x.claimToken === token);
  if (!me) throw new Error('Not your row to edit');
  return me;
}
const stamp = () => new Date().toISOString();

export const mode = 'local';

export async function createPlan({ title, start, end, activity, name }) {
  if (!String(title || '').trim()) throw new Error('A plan needs a title');
  if (end < start) throw new Error('The window ends before it starts');
  const d = db();
  const slug = slugify();
  const token = uuid();
  const me = name?.trim()
    ? { id: uuid(), name: name.trim(), claimToken: token, weekdays: [], blackouts: [],
        blackoutRanges: [], onlyDates: [], noticeDays: 0, note: '', unlocks: [],
        interests: {}, updatedAt: stamp() }
    : null;
  d.plans[slug] = {
    id: uuid(), slug, title: title.trim(), window: { start, end },
    activities: activity?.trim()
      ? [{ id: uuid(), title: activity.trim(), detail: '', proposedBy: name?.trim() || '', createdAt: stamp() }]
      : [],
    participants: me ? [me] : [],
    updatedAt: stamp(),
  };
  if (me && d.plans[slug].activities.length) {
    me.interests[d.plans[slug].activities[0].id] = { level: 'yes', note: '' };
  }
  write(d);
  return { slug, participantId: me?.id ?? null, token };
}

export async function getPlan(slug) {
  const p = db().plans[slug];
  if (!p) return null;
  // Never hand the claim tokens back to the client.
  return {
    ...p,
    participants: p.participants.map(({ claimToken, ...rest }) => ({ ...rest, claimed: !!claimToken })),
  };
}

export async function joinPlan(slug, name) {
  const d = db();
  const p = plan(d, slug);
  if (!String(name || '').trim()) throw new Error('A name is required');
  const clean = name.trim();
  const token = uuid();
  const existing = p.participants.find(x => x.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    if (existing.claimToken) { const e = new Error(`Someone already claimed the name ${existing.name}`); e.taken = true; throw e; }
    existing.claimToken = token;
    existing.updatedAt = stamp();
    write(d);
    return { participantId: existing.id, token };
  }
  const me = { id: uuid(), name: clean, claimToken: token, weekdays: [], blackouts: [],
    blackoutRanges: [], onlyDates: [], noticeDays: 0, note: '', unlocks: [],
    interests: {}, updatedAt: stamp() };
  p.participants.push(me);
  write(d);
  return { participantId: me.id, token };
}

export async function updateParticipant(slug, token, patch) {
  const d = db();
  const me = auth(d, slug, token);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') { if (String(v).trim()) me.name = String(v).trim(); }
    else me[k] = v;
  }
  me.updatedAt = stamp();
  write(d);
  return { ok: true };
}

export async function fillInFor(slug, token, name, patch = {}, interests = {}) {
  const d = db();
  auth(d, slug, token);                       // caller must be in the plan
  const p = plan(d, slug);
  const clean = String(name || '').trim();
  if (!clean) throw new Error('A name is required');

  let who = p.participants.find(x => x.name.toLowerCase() === clean.toLowerCase());
  if (!who) {
    who = { id: uuid(), name: clean, claimToken: null, weekdays: [], blackouts: [],
            blackoutRanges: [], onlyDates: [], noticeDays: 0, note: '', unlocks: [],
            interests: {}, updatedAt: stamp() };
    p.participants.push(who);
  } else if (who.claimToken) {
    throw new Error(`${who.name} has joined and controls their own answers`);
  }

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') { if (String(v).trim()) who.name = String(v).trim(); }
    else who[k] = v;
  }
  for (const [actId, level] of Object.entries(interests || {})) {
    if (!['yes', 'maybe', 'no', 'pending'].includes(level)) continue;
    if (!p.activities.some(a => a.id === actId)) continue;
    who.interests[actId] = { level, note: who.interests[actId]?.note || '' };
  }
  who.updatedAt = stamp();
  write(d);
  return { participantId: who.id };
}

export async function setInterest(slug, token, activityId, level, note) {
  if (!['yes', 'maybe', 'no', 'pending'].includes(level)) throw new Error(`Unknown interest level ${level}`);
  const d = db();
  const me = auth(d, slug, token);
  if (!plan(d, slug).activities.some(a => a.id === activityId)) {
    throw new Error('That activity is not part of this plan');
  }
  const prev = me.interests[activityId] || { level: 'pending', note: '' };
  me.interests[activityId] = { level, note: note ?? prev.note };
  me.updatedAt = stamp();
  write(d);
  return { ok: true };
}

export async function addActivity(slug, token, title, detail = '') {
  const d = db();
  const me = auth(d, slug, token);
  const p = plan(d, slug);
  if (!String(title || '').trim()) throw new Error('The activity needs a name');
  if (p.activities.length >= 12) throw new Error('That is already a dozen options — retire one first');
  const a = { id: uuid(), title: title.trim(), detail: String(detail || '').trim(),
              proposedBy: me.name, createdAt: stamp() };
  p.activities.push(a);
  me.interests[a.id] = { level: 'yes', note: '' };   // proposing counts as being up for it
  p.updatedAt = stamp();
  write(d);
  return { activityId: a.id };
}

export async function archiveActivity(slug, token, activityId) {
  const d = db();
  const me = auth(d, slug, token);
  const p = plan(d, slug);
  const a = p.activities.find(x => x.id === activityId);
  if (!a || a.proposedBy !== me.name) throw new Error('Only the person who proposed it can retire it');
  p.activities = p.activities.filter(x => x.id !== activityId);
  p.participants.forEach(x => delete x.interests[activityId]);
  p.updatedAt = stamp();
  write(d);
  return { ok: true };
}

export async function updatePlan(slug, token, title, start, end) {
  const d = db();
  auth(d, slug, token);
  if (end < start) throw new Error('The window ends before it starts');
  const p = plan(d, slug);
  if (String(title || '').trim()) p.title = title.trim();
  p.window = { start, end };
  p.updatedAt = stamp();
  write(d);
  return { ok: true };
}

export async function pulse(slug) {
  const p = db().plans[slug];
  if (!p) return null;
  return [p.updatedAt, ...p.participants.map(x => x.updatedAt)].sort().pop();
}

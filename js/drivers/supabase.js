// Supabase driver — every call is an RPC. The tables are closed to the anon
// role (see supabase-schema.sql); these functions are the whole API surface,
// which is what keeps a random visitor from enumerating other people's plans.

let sb = null;

export const mode = 'supabase';

export function init(url, anonKey) {
  if (!window.supabase?.createClient) {
    throw new Error('The Supabase client library did not load.');
  }
  sb = window.supabase.createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return sb;
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    // PGRST202 means the function isn't in this project — i.e. the deployed
    // app is ahead of the database. Say that, rather than "404".
    if (error.code === 'PGRST202') {
      const e = new Error(`This Supabase project doesn't have ${fn}() yet — run the latest supabase-schema.sql (or supabase-migration-2.sql) in the SQL editor.`);
      e.needsMigration = true;
      throw e;
    }
    // Postgres raises come back with the message we wrote in the schema;
    // surface that rather than a generic "400".
    const e = new Error(error.message || `${fn} failed`);
    e.code = error.code;
    if (error.code === '23505' || /already claimed/i.test(error.message || '')) e.taken = true;
    throw e;
  }
  return data;
}

export const createPlan = ({ title, start, end, activity, name }) =>
  rpc('create_plan', { p_title: title, p_start: start, p_end: end, p_activity: activity || '', p_name: name || '' });

export const getPlan = slug => rpc('get_plan', { p_slug: slug });

export const whoami = (slug, token) => rpc('whoami', { p_slug: slug, p_token: token });

export const releaseParticipant = (slug, token) =>
  rpc('release_participant', { p_slug: slug, p_token: token });

export const joinPlan = (slug, name) => rpc('join_plan', { p_slug: slug, p_name: name });

export const updateParticipant = (slug, token, patch) =>
  rpc('update_participant', { p_slug: slug, p_token: token, p_patch: patch });

export const fillInFor = (slug, token, name, patch = {}, interests = {}) =>
  rpc('fill_in_for', { p_slug: slug, p_token: token, p_name: name, p_patch: patch, p_interests: interests });

export const setInterest = (slug, token, activityId, level, note) =>
  rpc('set_interest', { p_slug: slug, p_token: token, p_activity: activityId, p_level: level, p_note: note ?? null });

export const addActivity = (slug, token, title, detail = '') =>
  rpc('add_activity', { p_slug: slug, p_token: token, p_title: title, p_detail: detail });

export const archiveActivity = (slug, token, activityId) =>
  rpc('archive_activity', { p_slug: slug, p_token: token, p_activity: activityId });

export const updatePlan = (slug, token, title, start, end) =>
  rpc('update_plan', { p_slug: slug, p_token: token, p_title: title, p_start: start, p_end: end });

export const pulse = slug => rpc('plan_pulse', { p_slug: slug });

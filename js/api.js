// Picks a driver at boot and re-exports it, so nothing above this line has to
// know whether the data is shared or living in one browser.

import * as local from './drivers/local.js';
import * as supa from './drivers/supabase.js';

const cfg = window.SHMAYBE_CONFIG || {};
const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
  && !/YOUR_/i.test(cfg.SUPABASE_URL));

let driver = local;
let failure = null;

if (configured) {
  try {
    supa.init(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    driver = supa;
  } catch (e) {
    // A misconfigured project shouldn't be a blank page — fall back to local
    // and let the UI say plainly that sharing is off.
    failure = e.message;
    console.warn('Supabase unavailable, falling back to this browser only:', e);
  }
}

export const mode = driver.mode;
export const configError = failure;
export const isShared = driver.mode === 'supabase';

export const createPlan        = (...a) => driver.createPlan(...a);
export const getPlan           = (...a) => driver.getPlan(...a);
export const joinPlan          = (...a) => driver.joinPlan(...a);
export const updateParticipant = (...a) => driver.updateParticipant(...a);
export const setInterest       = (...a) => driver.setInterest(...a);
export const addActivity       = (...a) => driver.addActivity(...a);
export const archiveActivity   = (...a) => driver.archiveActivity(...a);
export const updatePlan        = (...a) => driver.updatePlan(...a);
export const pulse             = (...a) => driver.pulse(...a);

/* --- Who am I, per plan. Kept in this browser; never sent anywhere. ------- */

const ID_KEY = 'shmaybe.identity.v1';

function identities() {
  try { return JSON.parse(localStorage.getItem(ID_KEY)) || {}; } catch { return {}; }
}
export function identity(slug) { return identities()[slug] || null; }
export function rememberIdentity(slug, id) {
  const all = identities();
  all[slug] = id;
  localStorage.setItem(ID_KEY, JSON.stringify(all));
}
export function forgetIdentity(slug) {
  const all = identities();
  delete all[slug];
  localStorage.setItem(ID_KEY, JSON.stringify(all));
}
/** Plans this browser has been part of, for the landing page. */
export function knownPlans() {
  return Object.entries(identities()).map(([slug, v]) => ({ slug, ...v }));
}

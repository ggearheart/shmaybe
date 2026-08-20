// Trip persistence. Everything lives in localStorage — no account, no server,
// and the whole state exports as one JSON file you can text to yourself.

import { todayYMD, addDays } from './dates.js';

const KEY = 'shmaybe.v1';
const LEGACY_KEYS = ['canyoujoin.v1'];   // the app was called "Can You Join?" first

let state = { trips: [], activeId: null };
const listeners = [];

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

export function blankParticipant(name = '') {
  return {
    id: uid('p'), name, status: 'pending',
    weekdays: [], blackouts: [], blackoutRanges: [], onlyDates: [],
    noticeDays: 0, note: '',
  };
}

export function blankTrip(title = 'Kayak to see the bats') {
  return {
    id: uid('t'),
    title,
    window: { start: todayYMD(), end: addDays(todayYMD(), 60) },
    participants: [],
    hypotheses: [],
    createdAt: todayYMD(),
  };
}

/** Fill in fields added after a trip was saved. */
function migrate(trip) {
  trip.hypotheses = trip.hypotheses || [];
  trip.participants = (trip.participants || []).map(p => ({
    weekdays: [], blackouts: [], blackoutRanges: [], onlyDates: [],
    noticeDays: 0, note: '', status: 'pending', ...p,
  }));
  return trip;
}

export function load() {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      // Carry trips over from a previous name rather than silently losing them.
      for (const old of LEGACY_KEYS) {
        const legacy = localStorage.getItem(old);
        if (legacy) { raw = legacy; localStorage.setItem(KEY, legacy); break; }
      }
    }
    if (raw) {
      const parsed = JSON.parse(raw);
      state = { trips: (parsed.trips || []).map(migrate), activeId: parsed.activeId || null };
    }
  } catch (e) {
    console.warn('Could not read saved trips; starting fresh.', e);
  }
  if (!state.trips.length) {
    const t = blankTrip();
    state.trips.push(t);
    state.activeId = t.id;
  }
  if (!state.trips.some(t => t.id === state.activeId)) state.activeId = state.trips[0].id;
  return state;
}

/** Persist and re-render. */
export function save() {
  saveQuiet();
  listeners.forEach(fn => fn(state));
}

/** Persist without re-rendering — for keystroke-by-keystroke text edits,
 *  where a re-render would yank the caret out of the field. */
export function saveQuiet() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save.', e);
  }
}

export function onChange(fn) { listeners.push(fn); }

export function getState() { return state; }
export function activeTrip() { return state.trips.find(t => t.id === state.activeId); }

export function setActive(id) { state.activeId = id; save(); }

export function addTrip(title) {
  const t = blankTrip(title || 'New trip');
  state.trips.push(t);
  state.activeId = t.id;
  save();
  return t;
}

export function deleteTrip(id) {
  state.trips = state.trips.filter(t => t.id !== id);
  if (!state.trips.length) state.trips.push(blankTrip());
  if (!state.trips.some(t => t.id === state.activeId)) state.activeId = state.trips[0].id;
  save();
}

export function exportJSON() {
  return JSON.stringify(state, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.trips)) throw new Error('That file has no trips in it.');
  state = { trips: parsed.trips.map(migrate), activeId: parsed.activeId || parsed.trips[0]?.id || null };
  if (!state.trips.length) { const t = blankTrip(); state.trips.push(t); state.activeId = t.id; }
  if (!state.trips.some(t => t.id === state.activeId)) state.activeId = state.trips[0].id;
  save();
}

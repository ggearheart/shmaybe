// The scheduling brain. Pure functions over a trip object — no DOM, no storage.
//
// A participant looks like:
//   { id, name, status: 'yes'|'maybe'|'no'|'pending',
//     weekdays: [0..6],        // allowed weekdays; empty = no weekday constraint
//     blackouts: ['YYYY-MM-DD'],
//     blackoutRanges: [{start, end}],
//     onlyDates: ['YYYY-MM-DD'],   // if non-empty, ONLY these dates work
//     noticeDays: 0,
//     note: '' }

import { eachDay, weekdayOf, daysBetween, todayYMD, WEEKDAY_LONG } from './dates.js';

/** How much a person's availability counts toward "inclusive". */
export const WEIGHT = { yes: 1, maybe: 0.6, pending: 0, no: 0 };

/** Everyone still in play. 'no' and 'pending' don't constrain the search. */
export function activeParticipants(trip) {
  return trip.participants.filter(p => p.status === 'yes' || p.status === 'maybe');
}

export const REASON_LABEL = {
  weekday: 'that weekday does not work',
  blackout: 'blacked out that date',
  notOnList: 'not on their short list of workable dates',
  notice: 'not enough advance notice',
};

/**
 * An "unlock" is the opposite of a blackout: a conditional offer, like "I could
 * do a Monday if we go after 5" or "I can make any Saturday work if someone can
 * carpool". It doesn't make a date available — it makes it available *if*
 * somebody solves the condition, which is a thing the organizer can act on.
 * @returns the matching unlock, or null
 */
export function unlockCovering(p, ymd) {
  for (const u of p.unlocks || []) {
    const byDate = (u.dates || []).includes(ymd);
    const byWeekday = (u.weekdays || []).includes(weekdayOf(ymd));
    // An unlock with neither scope is a blanket offer over the whole window.
    const blanket = !(u.dates || []).length && !(u.weekdays || []).length;
    if (byDate || byWeekday || blanket) return u;
  }
  return null;
}

/**
 * Can one person make one date?
 * Returns { ok, reason } where reason is a key of REASON_LABEL when ok === false.
 */
export function availability(p, ymd, asOf = todayYMD()) {
  const allowed = p.weekdays && p.weekdays.length ? p.weekdays : null;
  if (allowed && !allowed.includes(weekdayOf(ymd))) return { ok: false, reason: 'weekday' };

  if (p.blackouts && p.blackouts.includes(ymd)) return { ok: false, reason: 'blackout' };

  if (p.blackoutRanges) {
    for (const r of p.blackoutRanges) {
      if (daysBetween(r.start, ymd) >= 0 && daysBetween(ymd, r.end) >= 0) {
        return { ok: false, reason: 'blackout' };
      }
    }
  }

  if (p.onlyDates && p.onlyDates.length && !p.onlyDates.includes(ymd)) {
    return { ok: false, reason: 'notOnList' };
  }

  if (p.noticeDays > 0 && daysBetween(asOf, ymd) < p.noticeDays) {
    return { ok: false, reason: 'notice' };
  }

  return { ok: true, reason: null };
}

/** Score a single date: who's in, who's out, and why. */
export function scoreDate(trip, ymd, asOf = todayYMD()) {
  const active = activeParticipants(trip);
  const inIds = [], out = [];
  let score = 0, yesIn = 0, maybeIn = 0;

  const unlockable = [];
  for (const p of active) {
    const a = availability(p, ymd, asOf);
    if (a.ok) {
      inIds.push(p.id);
      score += WEIGHT[p.status];
      if (p.status === 'yes') yesIn++; else maybeIn++;
    } else {
      out.push({ id: p.id, reason: a.reason });
      const u = unlockCovering(p, ymd);
      if (u) unlockable.push({ id: p.id, condition: u.condition || u.text, unlockId: u.id });
    }
  }

  const maxScore = active.reduce((s, p) => s + WEIGHT[p.status], 0);
  return {
    date: ymd,
    weekday: weekdayOf(ymd),
    in: inIds,
    out,
    score,
    maxScore,
    yesIn,
    maybeIn,
    everyone: out.length === 0 && active.length > 0,
    coverage: maxScore > 0 ? score / maxScore : 0,
    unlockable,
    // Every single person who can't make it has an offer on the table.
    everyoneIfUnlocked: out.length > 0 && unlockable.length === out.length,
  };
}

/** Score every date in the trip window, best first. */
export function rankDates(trip, asOf = todayYMD(), filter = null) {
  const days = eachDay(trip.window.start, trip.window.end)
    .filter(d => daysBetween(asOf, d) >= 0)          // never propose the past
    .filter(d => !filter || filter(d));
  const scored = days.map(d => scoreDate(trip, d, asOf));
  return scored.sort((a, b) =>
    b.score - a.score ||
    b.yesIn - a.yesIn ||
    a.out.length - b.out.length ||
    (a.date < b.date ? -1 : 1)
  );
}

/**
 * Per-weekday rollup — this is the "should I even bother asking about
 * Saturdays?" view. One row per weekday that appears in the window.
 */
export function weekdaySummary(trip, asOf = todayYMD()) {
  const all = rankDates(trip, asOf);
  const byDay = new Map();
  for (const s of all) {
    if (!byDay.has(s.weekday)) byDay.set(s.weekday, []);
    byDay.get(s.weekday).push(s);
  }
  const rows = [];
  for (const [wd, list] of byDay) {
    const best = list.reduce((a, b) => (b.score > a.score ? b : a));
    rows.push({
      weekday: wd,
      label: WEEKDAY_LONG[wd],
      candidateCount: list.length,
      best,
      bestCoverage: best.coverage,
      fullCoverageDates: list.filter(s => s.everyone).map(s => s.date),
      avgCoverage: list.reduce((s, x) => s + x.coverage, 0) / list.length,
    });
  }
  return rows.sort((a, b) =>
    b.fullCoverageDates.length - a.fullCoverageDates.length ||
    b.bestCoverage - a.bestCoverage ||
    b.avgCoverage - a.avgCoverage
  );
}

/**
 * Who is actually costing you dates?
 *
 * `soleBlocks` counts dates where this person is the ONLY one who can't make
 * it — relax them and the date goes to full coverage. Broken out by reason so
 * you know what to ask them ("could you do it with 5 days notice instead of
 * 14?" is a much easier text to send than "can you be more flexible?").
 */
export function blockerAnalysis(trip, asOf = todayYMD()) {
  const active = activeParticipants(trip);
  const all = rankDates(trip, asOf);
  const stats = new Map(active.map(p => [p.id, {
    id: p.id, name: p.name, status: p.status,
    blocks: 0, soleBlocks: 0, soleByReason: {}, availableOn: 0,
  }]));

  for (const s of all) {
    for (const o of s.out) {
      const st = stats.get(o.id);
      if (!st) continue;
      st.blocks++;
      if (s.out.length === 1) {
        st.soleBlocks++;
        st.soleByReason[o.reason] = (st.soleByReason[o.reason] || 0) + 1;
      }
    }
    for (const id of s.in) stats.get(id).availableOn++;
  }

  return [...stats.values()].sort((a, b) => b.soleBlocks - a.soleBlocks || b.blocks - a.blocks);
}

/**
 * When no single date works for everyone, two dates often do. Find the pair
 * that covers the most people between them, preferring pairs that are close
 * together and that don't strand anyone on a date by themselves.
 */
export function bestSplit(trip, asOf = todayYMD(), poolSize = 60) {
  const active = activeParticipants(trip);
  if (active.length < 2) return null;

  const ranked = rankDates(trip, asOf);
  if (!ranked.length) return null;
  if (ranked[0].everyone) return null;          // a single date already works

  const pool = ranked.slice(0, poolSize);
  const weightOf = new Map(active.map(p => [p.id, WEIGHT[p.status]]));
  let best = null;

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j];
      const union = new Set([...a.in, ...b.in]);
      const covered = [...union].reduce((s, id) => s + weightOf.get(id), 0);
      const soloA = a.in.filter(id => !b.in.includes(id)).length;
      const soloB = b.in.filter(id => !a.in.includes(id)).length;
      const smallerLeg = Math.min(a.in.length, b.in.length);
      const gap = Math.abs(daysBetween(a.date, b.date));
      const cand = { a, b, covered, union, missing: active.filter(p => !union.has(p.id)), smallerLeg, gap, soloA, soloB };
      if (!best ||
          cand.covered > best.covered ||
          (cand.covered === best.covered && cand.smallerLeg > best.smallerLeg) ||
          (cand.covered === best.covered && cand.smallerLeg === best.smallerLeg && cand.gap < best.gap)) {
        best = cand;
      }
    }
  }
  return best;
}

/**
 * Evaluate a hypothesis like "all Saturdays" or "Mondays and Wednesdays"
 * without committing to it — this is what you log so you remember which
 * questions you've already burned on people.
 */
export function evaluateHypothesis(trip, weekdays, asOf = todayYMD()) {
  const filter = weekdays && weekdays.length ? (d => weekdays.includes(weekdayOf(d))) : null;
  const ranked = rankDates(trip, asOf, filter);
  const active = activeParticipants(trip);
  return {
    weekdays: weekdays || [],
    candidateCount: ranked.length,
    best: ranked[0] || null,
    fullCoverageDates: ranked.filter(s => s.everyone).map(s => s.date),
    top: ranked.slice(0, 5),
    activeCount: active.length,
  };
}

/**
 * One-line read on where the search stands, so the header always says
 * something true rather than something cheerful.
 */
export function verdict(trip, asOf = todayYMD()) {
  const active = activeParticipants(trip);
  const pending = trip.participants.filter(p => p.status === 'pending');
  if (!active.length) {
    return { tone: 'wait', text: pending.length
      ? `Waiting on ${pending.length} ${pending.length === 1 ? 'reply' : 'replies'} before there is anything to solve.`
      : 'Add people and mark who is interested.' };
  }
  const ranked = rankDates(trip, asOf);
  if (!ranked.length) return { tone: 'bad', text: 'No dates left in the window. Widen it.' };

  const full = ranked.filter(s => s.everyone);
  const dates = n => `${n} ${n === 1 ? 'date works' : 'dates work'}`;

  // With one person in, "works for all 1" is nonsense — and it's the state
  // every plan passes through while the first replies trickle in.
  if (active.length === 1) {
    const who = active[0].name || 'the one person in';
    return full.length
      ? { tone: 'good', text: `${dates(full.length)} for ${who} — still waiting on everyone else.` }
      : { tone: 'bad', text: `No date in the window works for ${who}.` };
  }
  if (full.length) {
    return { tone: 'good', text: `${dates(full.length)} for all ${active.length}.` };
  }
  const top = ranked[0];
  return {
    tone: 'partial',
    text: `No date works for everyone. Best is ${top.in.length} of ${active.length}.`,
  };
}

/* =========================================================================
 * Multi-activity
 *
 * Availability is given once per person; interest is given per activity. So
 * every activity is scored against the same calendar constraints but a
 * different roster of who actually wants to do it. That's what makes the
 * comparison meaningful: "we couldn't all make the kayak, but all five can
 * do the hike" is a fact about interest, not about dates.
 * ========================================================================= */

/** Project a plan into the single-activity shape the scorers above expect. */
export function activityView(plan, activityId) {
  return {
    window: plan.window,
    hypotheses: [],
    participants: plan.participants.map(p => ({
      ...p,
      status: p.interests?.[activityId]?.level || 'pending',
    })),
  };
}

/** Rank the activities by how well each one can actually be scheduled. */
export function compareActivities(plan, asOf = todayYMD()) {
  return (plan.activities || []).map(activity => {
    const view = activityView(plan, activity.id);
    const active = activeParticipants(view);
    const ranked = rankDates(view, asOf);
    const full = ranked.filter(s => s.everyone);
    const best = ranked[0] || null;
    const interested = view.participants.filter(p => p.status === 'yes').length;
    return {
      activity,
      view,
      activeCount: active.length,
      yesCount: interested,
      maybeCount: active.length - interested,
      noCount: view.participants.filter(p => p.status === 'no').length,
      pendingCount: view.participants.filter(p => p.status === 'pending').length,
      best,
      bestIn: best ? best.in.length : 0,
      fullCoverageDates: full.map(s => s.date),
      // The headline number: most people you can actually get in one place.
      reach: best ? best.in.length : 0,
      unlockableDates: ranked.filter(s => !s.everyone && s.everyoneIfUnlocked).map(s => s.date),
    };
  }).sort((a, b) =>
    b.reach - a.reach ||
    b.fullCoverageDates.length - a.fullCoverageDates.length ||
    b.yesCount - a.yesCount ||
    (a.activity.title < b.activity.title ? -1 : 1)
  );
}

/**
 * The actionable form of the unlocks: which conditions, if somebody solved
 * them, would turn a nearly-there date into one that works for everyone.
 * Grouped by the exact set of conditions so the organizer sees one job, not
 * one job per date.
 */
export function unlockOpportunities(view, asOf = todayYMD()) {
  const byKey = new Map();
  for (const s of rankDates(view, asOf)) {
    if (s.everyone || !s.everyoneIfUnlocked) continue;
    const conditions = s.unlockable
      .map(u => ({ id: u.id, condition: u.condition }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const key = conditions.map(c => `${c.id}:${c.condition}`).join('|');
    if (!byKey.has(key)) byKey.set(key, { conditions, dates: [], gain: s.out.length });
    byKey.get(key).dates.push(s.date);
  }
  return [...byKey.values()].sort((a, b) => b.dates.length - a.dates.length || a.gain - b.gain);
}

/** Everyone who hasn't said anything about anything yet. */
export function silentParticipants(plan) {
  const ids = (plan.activities || []).map(a => a.id);
  return plan.participants.filter(p =>
    !ids.some(id => p.interests?.[id] && p.interests[id].level !== 'pending'));
}

// Turns "maybe, depends on the week — my partner can only do Mon/Wed" into
// suggested constraints. It never applies anything on its own: it returns
// suggestions the organizer taps to accept, because a wrong guess that gets
// silently applied is worse than no guess at all.

import { fromYMD, toYMD, weekOf, fmtShort, WEEKDAY_LONG } from './dates.js';

const DAY_WORDS = [
  ['sunday', 'sundays', 'sun', 'suns'],
  ['monday', 'mondays', 'mon', 'mons'],
  ['tuesday', 'tuesdays', 'tue', 'tues', 'tuesdays'],
  ['wednesday', 'wednesdays', 'wed', 'weds'],
  ['thursday', 'thursdays', 'thu', 'thur', 'thurs'],
  ['friday', 'fridays', 'fri', 'fris'],
  ['saturday', 'saturdays', 'sat', 'sats'],
];

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// "two weeks notice" is at least as common as "14 days notice".
const NUM_WORDS = {
  a: 1, an: 1, one: 1, couple: 2, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
// Longest alternatives first so "an" can't be shadowed by "a".
const NUM_PATTERN = `(\\d+|${Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|')})`;

const NEGATIVE_NEAR = /\b(not|no|never|except|apart from|other than|besides|cant|can't|cannot|unavailable|away|out of town|busy|avoid|anything but|any day but|but not)\b/;

function findDayMentions(text) {
  const hits = [];
  for (let wd = 0; wd < 7; wd++) {
    for (const word of DAY_WORDS[wd]) {
      const re = new RegExp(`\\b${word}\\b`, 'g');
      let m;
      while ((m = re.exec(text))) hits.push({ weekday: wd, index: m.index, len: word.length });
    }
  }
  // Longest match wins at any given position (so "sat" inside "saturday" drops out).
  hits.sort((a, b) => a.index - b.index || b.len - a.len);
  const kept = [];
  for (const h of hits) {
    if (kept.some(k => h.index < k.index + k.len && h.index + h.len > k.index)) continue;
    kept.push(h);
  }
  return kept;
}

/** Is this mention inside a negative clause? Look back over the same clause. */
function isNegated(text, index) {
  const clauseStart = Math.max(
    text.lastIndexOf(',', index), text.lastIndexOf('.', index),
    text.lastIndexOf(';', index), text.lastIndexOf('—', index), 0
  );
  const before = text.slice(clauseStart, index);
  return NEGATIVE_NEAR.test(before);
}

function detectStatus(text) {
  const head = text.slice(0, 24);
  const test = (re) => re.test(head) || re.test(text);
  if (/\b(maybe|might|possibly|tentative|depends|not sure|unsure|probably|leaning|if\b)/.test(text)) {
    // "yes but depends" still reads as a soft yes; a bare "depends" is a maybe.
    if (/^\s*(yes|yep|yeah|yup|sure|absolutely|definitely|count me in|i'?m in)\b/.test(head)) return 'yes';
    return 'maybe';
  }
  if (/^\s*(no\b|nope|nah|can'?t|cannot|sorry|pass\b|out\b|count me out)/.test(head)) return 'no';
  if (test(/\b(count me out|i'?m out|can'?t make (it|any)|not going to work|have to pass)\b/)) return 'no';
  if (/^\s*i['’]?m in\b|^\s*in[!.\s]/.test(head)) return 'yes';
  if (test(/\b(yes|yep|yeah|yup|sure|i'?m in|im in|count me in|down for|definitely|absolutely|love to|sounds great)\b/)) return 'yes';
  return null;
}

function resolveDate(month, day, win) {
  // Pick the year that lands the date inside the trip window; fall back to the
  // window's start year so a typo still produces something visible.
  const startYear = fromYMD(win.start).getFullYear();
  const endYear = fromYMD(win.end).getFullYear();
  for (let y = startYear; y <= endYear; y++) {
    const cand = toYMD(new Date(y, month, day));
    if (cand >= win.start && cand <= win.end) return cand;
  }
  return toYMD(new Date(startYear, month, day));
}

function findDateMentions(text, win) {
  const out = [];

  // "sept 12", "October 3rd"
  const named = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g;
  let m;
  while ((m = named.exec(text))) {
    const mo = MONTHS[m[1]];
    const day = Number(m[2]);
    if (mo === undefined || day < 1 || day > 31) continue;
    out.push({ ymd: resolveDate(mo, day, win), index: m.index, raw: m[0].trim() });
  }

  // Bare ordinals: "the 14th", "the 3rd"
  const ordinal = /\bthe\s+(\d{1,2})(st|nd|rd|th)\b/g;
  while ((m = ordinal.exec(text))) {
    if (out.some(o => m.index >= o.index && m.index < o.index + o.raw.length + 4)) continue;
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    // Try each month the window touches.
    const start = fromYMD(win.start);
    for (let i = 0; i < 14; i++) {
      const probe = toYMD(new Date(start.getFullYear(), start.getMonth() + i, day));
      if (probe >= win.start && probe <= win.end) {
        out.push({ ymd: probe, index: m.index, raw: m[0].trim() });
        break;
      }
    }
  }

  return out.sort((a, b) => a.index - b.index);
}

/**
 * @returns {{ suggestions: Array<{key,label,detail,patch}>, status: string|null }}
 * Each suggestion carries a `patch` that app.js merges into the participant.
 */
export function parseReply(raw, win) {
  const text = String(raw || '').toLowerCase().replace(/’/g, "'");
  const suggestions = [];
  const push = (key, label, detail, patch) => suggestions.push({ key, label, detail, patch });

  const status = detectStatus(text);

  // --- Wide-open flexibility ------------------------------------------------
  if (/\b(any day|anytime|any time|whenever|whatever works|flexible|all good|works for me|open)\b/.test(text)
      && !NEGATIVE_NEAR.test(text)) {
    push('flex', 'Any day works', 'Clears their weekday restrictions', { weekdays: [] });
  }

  // --- Weekdays: groups ("weekends") and named days ("Mon/Wed") both feed one
  // --- pair of sets, so "weekends or Fridays" becomes a single suggestion. ---
  const positive = new Set(), negative = new Set();

  const addGroup = (re, days, label) => {
    const i = text.search(re);
    if (i < 0) return;
    const target = isNegated(text, i) ? negative : positive;
    days.forEach(d => target.add(d));
  };
  addGroup(/\bweekends?\b/, [0, 6]);
  addGroup(/\bweekdays?\b/, [1, 2, 3, 4, 5]);

  for (const h of findDayMentions(text)) {
    (isNegated(text, h.index) ? negative : positive).add(h.weekday);
  }

  const names = set => [...set].sort((a, b) => a - b).map(w => WEEKDAY_LONG[w]).join(' & ');

  if (positive.size) {
    // An explicit "not Tuesdays" carves out of an explicit "weekdays" list.
    const allowed = [...positive].filter(w => !negative.has(w)).sort((a, b) => a - b);
    if (allowed.length) {
      push('wd-only', `${names(new Set(allowed))} only`,
        `Limits them to ${allowed.length} day${allowed.length === 1 ? '' : 's'} a week`,
        { weekdays: allowed });
    }
  } else if (negative.size) {
    const allowed = [0, 1, 2, 3, 4, 5, 6].filter(w => !negative.has(w));
    push('wd-not', `No ${names(negative)}`, `Leaves ${allowed.length} weekdays open`, { weekdays: allowed });
  }

  // --- "week of the 14th" ---------------------------------------------------
  const weekRe = /\bweek of\s+(?:the\s+)?([a-z]{3,9}\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/g;
  let wm;
  while ((wm = weekRe.exec(text))) {
    const monthWord = (wm[1] || '').trim().replace('.', '');
    const mo = MONTHS[monthWord];
    const day = Number(wm[2]);
    let anchor = null;
    if (mo !== undefined) {
      anchor = resolveDate(mo, day, win);
    } else {
      const start = fromYMD(win.start);
      for (let i = 0; i < 14; i++) {
        const probe = toYMD(new Date(start.getFullYear(), start.getMonth() + i, day));
        if (probe >= win.start && probe <= win.end) { anchor = probe; break; }
      }
    }
    if (!anchor) continue;
    const wk = weekOf(anchor);
    push('range', `Block the week of ${fmtShort(anchor)}`,
      `${fmtShort(wk.start)} through ${fmtShort(wk.end)}`,
      { blackoutRanges: [wk] });
  }

  // --- Specific dates -------------------------------------------------------
  const dates = findDateMentions(text, win);
  const weekOfSpans = [...text.matchAll(/\bweek of\b/g)].map(m => m.index);
  const loose = dates.filter(d =>
    !weekOfSpans.some(i => d.index > i && d.index - i < 24) && !isNegated(text, d.index));

  // "the 19th or the 26th could work" — offer the whole short list in one tap.
  if (loose.length > 1) {
    const ymds = [...new Set(loose.map(d => d.ymd))].sort();
    push('od-all', `Only ${ymds.map(fmtShort).join(' or ')}`,
      `Their whole short list — ${ymds.length} dates`, { onlyDates: ymds });
  }

  for (const d of dates) {
    if (weekOfSpans.some(i => d.index > i && d.index - i < 24)) continue;  // already handled
    const neg = isNegated(text, d.index);
    const only = /\b(only|just|nothing but)\b/.test(text.slice(Math.max(0, d.index - 40), d.index));
    if (neg) {
      push(`bo-${d.ymd}`, `Block ${fmtShort(d.ymd)}`, 'Marks that one date unavailable', { blackouts: [d.ymd] });
    } else if (only) {
      push(`od-${d.ymd}`, `Only ${fmtShort(d.ymd)}`, 'Restricts them to this date', { onlyDates: [d.ymd] });
    } else {
      // Genuinely ambiguous — offer both and let the organizer pick.
      push(`od-${d.ymd}`, `Only ${fmtShort(d.ymd)}`, 'They can only do this date', { onlyDates: [d.ymd] });
      push(`bo-${d.ymd}`, `Block ${fmtShort(d.ymd)}`, 'They cannot do this date', { blackouts: [d.ymd] });
    }
  }

  // --- Advance notice -------------------------------------------------------
  const notice = new RegExp(`${NUM_PATTERN}\\s*(day|week)s?'?s?\\b[^.,;]{0,20}\\bnotice\\b`).exec(text)
             || new RegExp(`\\bnotice\\b[^.,;]{0,20}?${NUM_PATTERN}\\s*(day|week)s?`).exec(text);
  if (notice) {
    const raw = notice[1];
    const n = (/^\d+$/.test(raw) ? Number(raw) : NUM_WORDS[raw]) * (notice[2].startsWith('week') ? 7 : 1);
    if (n > 0 && n < 400) {
      push('notice', `Needs ${n} days notice`, 'Rules out dates that are too soon', { noticeDays: n });
    }
  }

  return { suggestions, status };
}

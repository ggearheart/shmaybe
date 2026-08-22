// Turns "maybe, depends on the week — my partner can only do Mon/Wed" into
// suggested constraints. It never applies anything on its own: it returns
// suggestions the organizer taps to accept, because a wrong guess that gets
// silently applied is worse than no guess at all.

import { fromYMD, toYMD, weekOf, fmtShort, addDays, daysBetween, WEEKDAY_LONG } from './dates.js';

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

// A conditional clause reverses the meaning of everything in it. "I could do a
// Monday if we go after 5" is an *offer*, not a restriction — treating that
// "Monday" as a hard constraint would be exactly backwards.
const COND_TRIGGER = /\b(if|as long as|so long as|provided that|provided|assuming)\b/;

/** Break a reply into clauses, keeping each one's offset in the original. */
function segmentsOf(text) {
  const out = [];
  const re = /[.!?;\n]+|,?\s+(?:but|though|however|although)\s+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ start: last, end: m.index, text: text.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ start: last, end: text.length, text: text.slice(last) });
  return out;
}

/**
 * @param text  lowercased, for matching
 * @param orig  same string with its original capitalisation, so the condition
 *              we show the user reads like they wrote it ("carpool from Davis",
 *              not "carpool from davis"). Both transforms that produce `text`
 *              preserve length, so the offsets line up.
 */
function conditionalSpans(text, orig) {
  return segmentsOf(text)
    .map(seg => {
      const m = COND_TRIGGER.exec(seg.text);
      if (!m) return null;
      const from = seg.start + m.index + m[0].length;
      const condition = orig.slice(from, seg.end).trim().replace(/^that\s+/i, '');
      // "only if" and "if not …" are restrictions in conditional clothing, not
      // offers. Treating them as offers invents a yes nobody gave.
      const before = seg.text.slice(0, m.index);
      const restrictive = /\bonly\s*$/.test(before.trimEnd() + ' ')
        || /\bonly\b[^.]{0,12}$/.test(before)
        || /^(not|it'?s not|isn'?t|no\b|there'?s no|unless)\b/.test(condition.toLowerCase());

      return {
        ...seg,
        restrictive,
        condition: condition || orig.slice(seg.start, seg.end).trim(),
        original: orig.slice(seg.start, seg.end).trim(),
        scopeText: seg.text.slice(0, m.index),
      };
    })
    .filter(Boolean);
}

const inSpans = (spans, i) => spans.some(sp => i >= sp.start && i < sp.end);

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
  // "in, as long as…" / "in!" / "I'm in". \b keeps this off "instead".
  if (/^\s*i['’]?m in\b|^\s*in\b/.test(head)) return 'yes';
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
  // Both of these preserve length, so indices into `text` are valid in `orig`.
  const orig = String(raw || '').replace(/’/g, "'");
  const text = orig.toLowerCase();
  const suggestions = [];
  const push = (key, label, detail, patch) => suggestions.push({ key, label, detail, patch });

  const status = detectStatus(text);

  // Anything inside a conditional clause is an offer, handled separately below.
  const condSpans = conditionalSpans(text, orig);
  // Only genuine offers are held back from the hard-constraint pass; a
  // restrictive conditional still has to produce its blackout.
  const offerSpans = condSpans.filter(sp => !sp.restrictive);
  const hard = i => !inSpans(offerSpans, i);

  // --- Wide-open flexibility ------------------------------------------------
  const flexAt = text.search(/\b(any day|anytime|any time|whenever|whatever works|flexible|all good|works for me|open)\b/);
  if (flexAt >= 0 && hard(flexAt) && !NEGATIVE_NEAR.test(text)) {
    push('flex', 'Any day works', 'Clears their weekday restrictions', { weekdays: [] });
  }

  // --- Weekdays: groups ("weekends") and named days ("Mon/Wed") both feed one
  // --- pair of sets, so "weekends or Fridays" becomes a single suggestion. ---
  const positive = new Set(), negative = new Set();

  const addGroup = (re, days) => {
    const i = text.search(re);
    if (i < 0 || !hard(i)) return;
    const target = isNegated(text, i) ? negative : positive;
    days.forEach(d => target.add(d));
  };
  addGroup(/\bweekends?\b/, [0, 6]);
  addGroup(/\bweekdays?\b/, [1, 2, 3, 4, 5]);

  for (const h of findDayMentions(text)) {
    if (!hard(h.index)) continue;
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
    if (!hard(wm.index)) continue;   // inside an offer, not a blackout
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

  // --- Open-ended cutoffs: "before Sept 5th", "after the 20th" -------------
  // Val wrote "Before Sept 5th." and it vanished: the date was read as a single
  // day rather than a boundary, so the hardest constraint in the message was
  // the one thing that didn't land.
  // "the" is deliberately left for the date matcher — the bare-ordinal rule
  // needs it ("by the 15th" finds nothing if "the" is eaten here).
  const cutoffRe = /\b(before|after|by|from|starting|until|til|till|up to|no later than|no earlier than)\s+/g;
  const cutoffs = [];
  let cm;
  while ((cm = cutoffRe.exec(text))) {
    if (!hard(cm.index)) continue;
    const at = cm.index + cm[0].length;
    const tail = text.slice(at, at + 28);
    let hit = findDateMentions(tail, win)[0];

    // "before October" — a month with no day means the start of that month.
    if (!hit || hit.index > 5) {
      const mo = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/.exec(tail);
      if (mo && MONTHS[mo[1]] !== undefined) {
        hit = { ymd: resolveDate(MONTHS[mo[1]], 1, win), index: 0 };
      } else continue;
    }

    const word = cm[1];
    let isBefore = /^(before|by|until|til|till|up to|no later than)$/.test(word);
    // "not until October" is the opposite of "until October".
    if (/\bnot\s+$/.test(text.slice(Math.max(0, cm.index - 6), cm.index))) isBefore = !isBefore;

    if (isBefore) {
      // "before Sept 5" rules out Sept 5 onwards; "by Sept 5" is the same ask.
      if (daysBetween(hit.ymd, win.end) >= 0) {
        push(`cut-b-${hit.ymd}`, `Nothing from ${fmtShort(hit.ymd)} onwards`,
          `Keeps it before ${fmtShort(hit.ymd)}`,
          { blackoutRanges: [{ start: hit.ymd, end: win.end }] });
      }
    } else {
      // "after the 20th" / "from the 20th" rules out everything up to it.
      const cut = addDays(hit.ymd, word === 'after' ? 0 : -1);
      if (daysBetween(win.start, cut) >= 0) {
        push(`cut-a-${hit.ymd}`, `Nothing before ${fmtShort(hit.ymd)}`,
          `Keeps it ${word} ${fmtShort(hit.ymd)}`,
          { blackoutRanges: [{ start: win.start, end: cut }] });
      }
    }
    cutoffs.push(at + hit.index);
  }

  // --- Specific dates -------------------------------------------------------
  const dates = findDateMentions(text, win);
  const weekOfSpans = [...text.matchAll(/\bweek of\b/g)].map(m => m.index);
  const nearCutoff = i => cutoffs.some(c => Math.abs(c - i) <= 3);
  const loose = dates.filter(d => hard(d.index) && !nearCutoff(d.index) &&
    !weekOfSpans.some(i => d.index > i && d.index - i < 24) && !isNegated(text, d.index));

  // "the 19th or the 26th could work" — offer the whole short list in one tap.
  if (loose.length > 1) {
    const ymds = [...new Set(loose.map(d => d.ymd))].sort();
    push('od-all', `Only ${ymds.map(fmtShort).join(' or ')}`,
      `Their whole short list — ${ymds.length} dates`, { onlyDates: ymds });
  }

  for (const d of dates) {
    if (!hard(d.index)) continue;                                          // it's an offer, see below
    if (nearCutoff(d.index)) continue;                                     // already read as a cutoff
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

  // --- Conditional offers ("opportunities to participate") ----------------
  for (const span of offerSpans) {
    const scopeDays = findDayMentions(span.scopeText || span.text).map(h => h.weekday);
    const scopeDates = findDateMentions(span.scopeText || span.text, win).map(d => d.ymd);
    const uniqDays = [...new Set(scopeDays)].sort((a, b) => a - b);
    const uniqDates = [...new Set(scopeDates)];

    const scopeLabel = uniqDays.length ? uniqDays.map(w => WEEKDAY_LONG[w] + 's').join(' & ')
                     : uniqDates.length ? uniqDates.map(fmtShort).join(', ')
                     : 'any date';
    const condition = span.condition.replace(/\s+/g, ' ').trim();
    const short = condition.length > 46 ? condition.slice(0, 45).trimEnd() + '…' : condition;

    push(`unlock-${span.start}`, `Could do ${scopeLabel} — if ${short}`,
      'Records it as an offer to unlock, not a limit',
      { unlocks: [{
          id: 'u-' + span.start,
          text: span.original,
          condition,
          weekdays: uniqDays,
          dates: uniqDates,
        }] });
  }

  return { suggestions, status };
}

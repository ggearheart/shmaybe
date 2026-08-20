// Turns a pasted (or OCR'd) group conversation into per-speaker messages.
//
// Nothing here decides anything: it produces a best guess with a confidence
// signal, and the UI shows every line for reassignment before a single
// constraint is applied. Speaker attribution from a screenshot is never going
// to be perfect, so the design assumes it's wrong sometimes.

/** Roster names are the strongest signal we have — use them everywhere. */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Match a detected speaker label to somebody already in the plan.
 * Deliberately conservative: a wrong match silently files someone's
 * constraints under the wrong person, which is worse than no match.
 */
export function matchRoster(label, roster) {
  const n = normName(label);
  if (!n) return null;
  const cands = roster.map(p => ({ p, n: normName(p.name) }));

  let hit = cands.find(c => c.n === n);                                   // exact
  if (hit) return hit.p;
  hit = cands.find(c => c.n.split(' ')[0] === n.split(' ')[0]);           // same first name
  if (hit) return hit.p;
  hit = cands.find(c => c.n.startsWith(n) || n.startsWith(c.n));          // "Sara" vs "Sara M"
  if (hit) return hit.p;
  // Initial-plus-surname ("S. Miller") and OCR dropping a letter are common,
  // but guessing there does more harm than leaving it for the human.
  return null;
}

const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|AM|PM)?`;
const DATE = String.raw`\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?`;

// "[20/08/2026, 10:14:32] Sara: text"  /  "20/08/2026, 10:14 - Sara: text"
const RE_WHATSAPP = new RegExp(
  String.raw`^\s*[\[\(]?\s*${DATE},?\s*${TIME}\s*[\]\)]?\s*[-–—]?\s*([^:]{1,40}?)\s*:\s*(.*)$`);

// "Sara: text" — the format most people produce when they retype a thread.
const RE_NAMED = /^\s*([A-Za-z][\w'’.\- ]{0,28}?)\s*:\s+(.+)$/;

// "Sara  10:14 AM" on its own line (Slack, Discord, some SMS exports),
// or just "Sara" above their bubble (iMessage group screenshots).
const RE_HEADER = new RegExp(String.raw`^\s*([A-Za-z][\w'’.\- ]{0,28}?)\s*(?:[-–—]?\s*${TIME})?\s*$`);

// Lines that are chrome, not conversation.
const RE_NOISE = new RegExp(
  String.raw`^\s*(?:${TIME}|${DATE}|(?:today|yesterday)(?:\s+${TIME})?|delivered|read|sent|imessage|text message|sms|mms|` +
  String.raw`(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\s+${TIME})?|` +
  String.raw`\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+${TIME})?)\s*$`, 'i');

const isNoise = line => !line.trim() || RE_NOISE.test(line);

/**
 * @param {string} raw       the pasted conversation
 * @param {Array}  roster    plan participants, for name matching
 * @returns {{messages: Array, format: string, unmatched: string[]}}
 *   messages: [{ speaker, participantId, text, confidence }]
 */
export function splitThread(raw, roster = []) {
  const lines = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍﻿]/g, '')
    .split('\n');

  const messages = [];
  let format = 'blocks';
  let current = null;

  const push = (speaker, text, confidence) => {
    current = { speaker: speaker || null, text: text || '', confidence };
    messages.push(current);
  };
  const append = text => {
    // Continuation only makes sense under a known speaker. With nobody
    // attributed, keep each line separate so the reviewer can assign them
    // individually — merging would force everything onto one person.
    if (current && current.speaker) current.text += (current.text ? ' ' : '') + text.trim();
    else push(null, text.trim(), 'low');
  };

  // A header line is only a speaker if it isn't just a short message. Knowing
  // the roster is what makes this safe — "Sounds good" won't match a name.
  const looksLikeSpeaker = label => {
    if (!label) return false;
    if (matchRoster(label, roster)) return true;
    // With no roster hit, insist on a plausible name shape: one or two
    // capitalised words, no trailing punctuation.
    return /^[A-Z][a-z’'\-]{1,15}(?: [A-Z][a-z’'\-]{1,15})?$/.test(label.trim());
  };

  for (const line of lines) {
    if (isNoise(line)) { current = null; continue; }

    let m = RE_WHATSAPP.exec(line);
    if (m && looksLikeSpeaker(m[1])) {
      format = 'timestamped';
      push(m[1].trim(), m[2].trim(), 'high');
      continue;
    }

    m = RE_NAMED.exec(line);
    if (m && looksLikeSpeaker(m[1])) {
      if (format === 'blocks') format = 'named';
      push(m[1].trim(), m[2].trim(), 'high');
      continue;
    }

    m = RE_HEADER.exec(line);
    if (m && looksLikeSpeaker(m[1]) && matchRoster(m[1], roster)) {
      // Only treat a bare line as a speaker header when it's a known person —
      // otherwise a one-word reply becomes a phantom participant.
      if (format === 'blocks') format = 'headers';
      push(m[1].trim(), '', 'high');
      continue;
    }

    append(line);
  }

  // Attach roster matches and drop anything that ended up empty.
  const out = messages
    .filter(x => x.text.trim())
    .map(x => {
      const p = x.speaker ? matchRoster(x.speaker, roster) : null;
      return {
        speaker: x.speaker,
        participantId: p ? p.id : null,
        text: x.text.trim(),
        confidence: x.confidence,
      };
    });

  const unmatched = [...new Set(
    out.filter(x => x.speaker && !x.participantId).map(x => x.speaker))];

  return { messages: out, format, unmatched };
}

/**
 * Collapse a thread to one blob of text per person, which is what the
 * constraint parser wants — somebody's constraints are often spread over
 * three consecutive messages.
 */
export function groupBySpeaker(messages) {
  const by = new Map();
  for (const m of messages) {
    if (!m.participantId) continue;
    if (!by.has(m.participantId)) by.set(m.participantId, []);
    by.get(m.participantId).push(m.text);
  }
  return [...by.entries()].map(([participantId, texts]) => ({
    participantId,
    text: texts.join('. ').replace(/\.\s*\./g, '.'),
  }));
}

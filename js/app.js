import {
  WEEKDAY_LONG, WEEKDAY_MIN, WEEKDAY_SHORT,
  todayYMD, addDays, fmtShort, fmtLong, fmtRange, eachDay, daysBetween,
} from './dates.js';
import {
  rankDates, weekdaySummary, blockerAnalysis, bestSplit,
  evaluateHypothesis, verdict, activeParticipants, REASON_LABEL,
} from './solver.js';
import { parseReply } from './parse.js';
import * as store from './store.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Transient view state — deliberately not persisted.
const ui = {
  tab: 'people',
  openPeople: new Set(),
  suggestions: new Map(),   // participantId -> parse result
  openDates: new Set(),
  probeDays: new Set(),
  showAllDates: false,
};

let trip;   // the active trip, refreshed on every render

/* ------------------------------------------------------------------ people */

function constraintChips(p) {
  const chips = [];
  if (p.weekdays.length && p.weekdays.length < 7) {
    chips.push(p.weekdays.map(w => WEEKDAY_SHORT[w]).join(', ') + ' only');
  }
  if (p.onlyDates.length) chips.push('only ' + p.onlyDates.map(fmtShort).join(', '));
  const blocked = p.blackouts.length + p.blackoutRanges.length;
  if (blocked) chips.push(`${blocked} blackout${blocked === 1 ? '' : 's'}`);
  if (p.noticeDays > 0) chips.push(`${p.noticeDays}d notice`);
  return chips;
}

function personCard(p) {
  const open = ui.openPeople.has(p.id);
  const chips = constraintChips(p);
  const statuses = [['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No'], ['pending', '?']];

  const summary = chips.length
    ? chips.map(c => `<span class="constraint-chip">${esc(c)}</span>`).join('')
    : `<span class="constraint-chip free">${p.status === 'no' ? 'not coming' : 'no limits given'}</span>`;

  return `
  <div class="card person ${p.status === 'no' ? 'is-no' : ''}" data-pid="${p.id}">
    <div class="person-head">
      <input class="person-name" value="${esc(p.name)}" data-act="rename" aria-label="Name">
      <div class="statusgroup">
        ${statuses.map(([v, label]) => `
          <button data-act="status" data-status="${v}" aria-pressed="${p.status === v}"
                  title="${label}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="person-summary">
      ${summary}
      <button class="disclose" data-act="toggle">${open ? 'Close' : 'Edit'}</button>
    </div>
    ${open ? personDetail(p) : ''}
  </div>`;
}

function personDetail(p) {
  const sugg = ui.suggestions.get(p.id);
  return `
  <div class="person-detail">
    <div class="field">
      <span>Days of the week that work</span>
      <div class="daypicker" data-act="weekdays">
        ${WEEKDAY_MIN.map((m, i) => `
          <button data-wd="${i}" aria-label="${WEEKDAY_LONG[i]}"
            aria-pressed="${p.weekdays.length === 0 || p.weekdays.includes(i)}">${m}</button>`).join('')}
      </div>
      <p class="hint">${p.weekdays.length === 0 || p.weekdays.length === 7
        ? 'Any day works for them.' : 'Only the highlighted days.'}</p>
    </div>

    <div class="field">
      <span>Dates they can't do</span>
      <div class="datechips">
        ${p.blackouts.map(d => `<span class="datechip">${esc(fmtShort(d))}
          <button data-act="rm-blackout" data-val="${d}" aria-label="Remove">×</button></span>`).join('')}
        ${p.blackoutRanges.map((r, i) => `<span class="datechip">${esc(fmtRange(r.start, r.end))}
          <button data-act="rm-range" data-val="${i}" aria-label="Remove">×</button></span>`).join('')}
      </div>
      <div class="inline-add">
        <input type="date" data-act="blackout-input" min="${trip.window.start}" max="${trip.window.end}">
        <button class="btn btn-sm" data-act="add-blackout">Block this date</button>
      </div>
    </div>

    <div class="field">
      <span>Only these dates work</span>
      <div class="datechips">
        ${p.onlyDates.map(d => `<span class="datechip only">${esc(fmtShort(d))}
          <button data-act="rm-only" data-val="${d}" aria-label="Remove">×</button></span>`).join('')}
      </div>
      <div class="inline-add">
        <input type="date" data-act="only-input" min="${trip.window.start}" max="${trip.window.end}">
        <button class="btn btn-sm" data-act="add-only">Add date</button>
      </div>
      <p class="hint">Leave empty unless they gave you an exact short list.</p>
    </div>

    <div class="field">
      <span>Advance notice needed</span>
      <div class="inline-add">
        <input type="number" min="0" max="365" step="1" value="${p.noticeDays}" data-act="notice" style="width:5rem">
        <label>days</label>
      </div>
    </div>

    <div class="field">
      <span>What they actually said</span>
      <textarea data-act="note" placeholder="maybe — depends on the week, my partner can only do Mon/Wed">${esc(p.note)}</textarea>
      <div class="inline-add">
        <button class="btn btn-sm btn-primary" data-act="parse">Read it &amp; suggest</button>
      </div>
    </div>

    ${sugg ? suggestionBlock(p, sugg) : ''}

    <div class="inline-add" style="margin-top:.6rem">
      <button class="btn btn-sm btn-danger" data-act="remove-person">Remove ${esc(p.name || 'person')}</button>
    </div>
  </div>`;
}

function suggestionBlock(p, sugg) {
  if (!sugg.suggestions.length && !sugg.status) {
    return `<div class="suggestions"><h4>Nothing recognised</h4>
      <p class="hint">No constraints found in that text — set them by hand above.</p></div>`;
  }
  const statusChip = sugg.status && sugg.status !== p.status
    ? `<button class="sugg" data-act="apply-status" data-status="${sugg.status}">
         Mark as ${esc(sugg.status)}<small>They currently show as ${esc(p.status)}</small></button>` : '';
  return `
  <div class="suggestions">
    <h4>Tap what's right</h4>
    <div class="sugg-list">
      ${statusChip}
      ${sugg.suggestions.map((s, i) => `
        <button class="sugg" data-act="apply-sugg" data-idx="${i}">
          ${esc(s.label)}<small>${esc(s.detail)}</small></button>`).join('')}
    </div>
  </div>`;
}

function renderPeople() {
  $('#trip-title').value = trip.title;
  $('#win-start').value = trip.window.start;
  $('#win-end').value = trip.window.end;

  const days = eachDay(trip.window.start, trip.window.end).filter(d => daysBetween(todayYMD(), d) >= 0);
  const counts = trip.participants.reduce((a, p) => (a[p.status]++, a), { yes: 0, maybe: 0, no: 0, pending: 0 });
  $('#window-hint').textContent =
    `${days.length} candidate day${days.length === 1 ? '' : 's'} · ` +
    `${counts.yes} yes, ${counts.maybe} maybe, ${counts.no} no, ${counts.pending} unanswered`;

  $('#people-list').innerHTML = trip.participants.length
    ? trip.participants.map(personCard).join('')
    : `<div class="card empty">Nobody yet. Add the people you'd text, then mark each one
       yes / maybe / no as they reply.</div>`;
}

/* ------------------------------------------------------------------- when */

function nameOf(id) {
  const p = trip.participants.find(x => x.id === id);
  return p ? (p.name || 'unnamed') : 'unknown';
}

function dateRow(s, active) {
  const open = ui.openDates.has(s.date);
  const pct = Math.round(s.coverage * 100);
  const why = open ? `
    <div class="daterow-why">
      ${s.in.length ? `<b>In:</b> ${s.in.map(id => esc(nameOf(id))).join(', ')}<br>` : ''}
      ${s.out.length
        ? `<b>Out:</b> ${s.out.map(o => `${esc(nameOf(o.id))} — ${REASON_LABEL[o.reason]}`).join('; ')}`
        : '<b>Everyone can make it.</b>'}
    </div>` : '';
  return `
    <button class="daterow ${s.everyone ? 'full' : ''}" data-act="toggle-date" data-date="${s.date}">
      <span class="daterow-date">${esc(fmtShort(s.date))}</span>
      <span class="daterow-bar"><i style="width:${pct}%"></i></span>
      <span class="daterow-count">${s.in.length}/${active}</span>
    </button>${why}`;
}

function renderResults() {
  const active = activeParticipants(trip);
  const box = $('#results');

  if (!active.length) {
    box.innerHTML = `<div class="card empty">Mark at least one person <b>yes</b> or <b>maybe</b>
      and the date search starts here.</div>`;
    return;
  }

  const ranked = rankDates(trip);
  const shown = ui.showAllDates ? ranked : ranked.slice(0, 8);
  const full = ranked.filter(s => s.everyone);
  const rollup = weekdaySummary(trip);
  const blockers = blockerAnalysis(trip).filter(b => b.blocks > 0);
  const split = bestSplit(trip);
  const tested = new Set(trip.hypotheses.flatMap(h => h.weekdays));

  let html = `
  <div class="card">
    <h2>Best dates${full.length ? ` · ${full.length} work${full.length === 1 ? 's' : ''} for everyone` : ''}</h2>
    <p class="hint">Ranked by how many people can make it. A <em>maybe</em> counts a bit less than a <em>yes</em>. Tap a row for the reasons.</p>
    <div style="margin-top:.5rem">${shown.map(s => dateRow(s, active.length)).join('') ||
      '<p class="hint">No dates left in the window.</p>'}</div>
    ${ranked.length > 8 ? `<div class="inline-add"><button class="btn btn-sm btn-ghost" data-act="toggle-all-dates">
      ${ui.showAllDates ? 'Show top 8 only' : `Show all ${ranked.length} dates`}</button></div>` : ''}
  </div>`;

  html += `
  <div class="card">
    <h2>Which weekday to chase</h2>
    <p class="hint">Aggregated across the whole window — this is the question to ask before you ask about a specific date.</p>
    <table class="rollup">
      <thead><tr><th>Day</th><th class="num">Dates</th><th class="num">Best</th><th class="num">All-in</th><th></th></tr></thead>
      <tbody>
        ${rollup.map(r => `
          <tr class="${r.fullCoverageDates.length ? 'win' : ''}">
            <td>${esc(r.label)}s</td>
            <td class="num">${r.candidateCount}</td>
            <td class="num">${r.best.in.length}/${active.length}</td>
            <td class="num">${r.fullCoverageDates.length}</td>
            <td class="num" style="color:var(--ink-3);font-size:.72rem">
              ${tested.has(r.weekday) ? 'tested' : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;

  if (blockers.length) {
    html += `
    <div class="card">
      <h2>Who is costing you dates</h2>
      <p class="hint">“Sole blocker” means everyone else was free — relax that one constraint and the date opens up.</p>
      <div style="margin-top:.5rem">
        ${blockers.map(b => {
          const reasons = Object.entries(b.soleByReason)
            .map(([r, n]) => `${n}× ${REASON_LABEL[r]}`).join(', ');
          return `<div class="blocker">
            <b>${esc(b.name || 'unnamed')}</b>
            <span>free on ${b.availableOn} of ${b.availableOn + b.blocks} dates${
              b.soleBlocks ? ` · <strong>sole blocker on ${b.soleBlocks}</strong>${reasons ? ` (${esc(reasons)})` : ''}` : ''}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  if (split) {
    const missing = split.missing.map(p => p.name || 'unnamed');
    html += `
    <div class="card">
      <h2>Or run it twice</h2>
      <p class="hint">No single date catches everyone, but these two together reach ${split.union.size} of ${active.length}.</p>
      <div style="margin-top:.5rem">
        <div class="split-leg"><b>${esc(fmtLong(split.a.date))}</b> — ${split.a.in.map(id => esc(nameOf(id))).join(', ')}</div>
        <div class="split-leg"><b>${esc(fmtLong(split.b.date))}</b> — ${split.b.in.map(id => esc(nameOf(id))).join(', ')}</div>
      </div>
      ${missing.length ? `<p class="hint">Still misses ${esc(missing.join(', '))}.</p>` : ''}
    </div>`;
  }

  box.innerHTML = html;
}

function renderProbe() {
  $('#probe-days').innerHTML = WEEKDAY_MIN.map((m, i) => `
    <button data-wd="${i}" aria-label="${WEEKDAY_LONG[i]}"
      aria-pressed="${ui.probeDays.has(i)}">${m}</button>`).join('');

  const box = $('#probe-result');
  if (!ui.probeDays.size) { box.innerHTML = ''; return; }
  const r = evaluateHypothesis(trip, [...ui.probeDays]);
  if (!r.activeCount) { box.innerHTML = `<p class="hint">Nobody is marked yes or maybe yet.</p>`; return; }
  box.innerHTML = `
    <p class="hint" style="margin-top:.6rem">
      ${r.candidateCount} matching date${r.candidateCount === 1 ? '' : 's'} ·
      ${r.fullCoverageDates.length
        ? `<b style="color:var(--yes)">${r.fullCoverageDates.length} work for all ${r.activeCount}</b>`
        : r.best ? `best covers ${r.best.in.length} of ${r.activeCount} (${esc(fmtShort(r.best.date))})`
                 : 'none available'}
    </p>`;
}

function renderLog() {
  const box = $('#hypothesis-log');
  if (!trip.hypotheses.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
  <div class="card">
    <h2>What you've already tried</h2>
    <div class="loglist" style="margin-top:.4rem">
      ${trip.hypotheses.slice().reverse().map(h => `
        <div class="logitem ${h.fullCount ? 'hit' : ''}">
          <span class="dot"></span>
          <div>
            <b>${esc(h.label)}</b>
            <span>${h.candidateCount} date${h.candidateCount === 1 ? '' : 's'} ·
              ${h.fullCount ? `${h.fullCount} worked for all ${h.activeCount}`
                            : h.bestDate ? `best was ${h.bestIn}/${h.activeCount} on ${esc(fmtShort(h.bestDate))} — ruled out`
                                         : 'nothing available'}
              · checked ${esc(fmtShort(h.testedOn))}</span>
          </div>
          <button class="rm" data-act="rm-hypothesis" data-id="${h.id}" aria-label="Delete">×</button>
        </div>`).join('')}
    </div>
  </div>`;
}

/* -------------------------------------------------------------------- ask */

function draft(id, title, hint, body) {
  return `
  <div class="card draft">
    <h2>${esc(title)}</h2>
    <p class="hint">${hint}</p>
    <textarea id="${id}" style="margin-top:.5rem">${esc(body)}</textarea>
    <div class="draft-actions">
      <button class="btn btn-sm btn-primary" data-act="copy" data-target="${id}">Copy</button>
      <span class="copied" data-copied="${id}" hidden>Copied</span>
    </div>
  </div>`;
}

function renderAsk() {
  const active = activeParticipants(trip);
  const pending = trip.participants.filter(p => p.status === 'pending');
  const what = trip.title || 'the trip';
  const win = `${fmtShort(trip.window.start)} and ${fmtShort(trip.window.end)}`;
  let html = '';

  html += draft('draft-1', 'Round 1 — are you interested?',
    'The opener. Ask for interest and hard weekday limits in one text, so round 2 is already narrowed.',
    `Thinking about ${what} sometime between ${win}. Are you in?\n\n` +
    `Reply yes / maybe / no — and if there are days of the week that never work for you, ` +
    `say which. No need to check a calendar yet.`);

  if (pending.length) {
    html += draft('draft-nudge', 'Chase the quiet ones',
      `${pending.length} ${pending.length === 1 ? 'person hasn\'t' : 'people haven\'t'} answered yet.`,
      `Hey ${pending.map(p => p.name || 'there').join(', ')} — still hoping to pin down ${what}. ` +
      `Even a "maybe" helps me pick a date. Any days of the week that are out for you?`);
  }

  if (active.length) {
    const ranked = rankDates(trip);
    const full = ranked.filter(s => s.everyone);
    if (full.length) {
      // Short form in comma-separated lists — "Saturday, Sep 5, Saturday, Sep 12"
      // is unreadable once the day name carries its own comma.
      const picks = full.slice(0, 3).map(s => fmtShort(s.date));
      html += draft('draft-2', 'Round 2 — lock it in',
        'These clear every constraint you have recorded.',
        `Good news — ${picks.length === 1 ? 'this date works' : 'these all work'} for everyone: ` +
        `${picks.join(', ')}.\n\nI'm leaning ${fmtLong(full[0].date)}. Any objection before I book it?`);
    } else if (ranked.length) {
      const picks = ranked.slice(0, 3);
      html += draft('draft-2', 'Round 2 — narrow it down',
        'Nothing catches everyone, so offer the best few and name what the sticking point is.',
        `No single date works for all of us, so here are the closest three for ${what}:\n\n` +
        picks.map(s => `• ${fmtLong(s.date)} — works for ${s.in.map(nameOf).join(', ')}`).join('\n') +
        `\n\nCan anyone stretch? If not I'll go with ${fmtLong(picks[0].date)}.`);

      const blockers = blockerAnalysis(trip).filter(b => b.soleBlocks > 0);
      for (const b of blockers.slice(0, 2)) {
        const reason = Object.keys(b.soleByReason)[0];
        const ask = {
          weekday: 'is that weekday truly impossible, or just inconvenient?',
          blackout: 'is that date locked in, or could it move?',
          notOnList: 'are there any other dates that could work?',
          notice: 'could you make it work with shorter notice?',
        }[reason] || 'is there any flex there?';
        const dates = rankDates(trip)
          .filter(s => s.out.length === 1 && s.out[0].id === b.id)
          .slice(0, 3).map(s => fmtShort(s.date));
        html += draft(`draft-b-${b.id}`, `Ask ${b.name || 'them'} directly`,
          `Everything else lines up on ${b.soleBlocks} date${b.soleBlocks === 1 ? '' : 's'} — only ${esc(b.name || 'they')} can't.`,
          `Hey ${b.name || 'there'} — ${dates.length === 1 ? 'this date works' : 'these work'} for everyone else: ` +
          `${dates.join(', ')}. ${ask.charAt(0).toUpperCase() + ask.slice(1)} ` +
          `Totally fine either way, I just want to know before I pick.`);
      }
    }

    const split = bestSplit(trip);
    if (split) {
      html += draft('draft-split', 'Propose two trips',
        'When one date can\'t hold everyone, two smaller ones usually can.',
        `Looks like one date won't catch all of us. What if we run ${what} twice?\n\n` +
        `• ${fmtLong(split.a.date)} — ${split.a.in.map(nameOf).join(', ')}\n` +
        `• ${fmtLong(split.b.date)} — ${split.b.in.map(nameOf).join(', ')}\n\n` +
        `Come to either, or both.`);
    }
  }

  $('#drafts').innerHTML = html || '<div class="card empty">Add some people first.</div>';
}

/* ------------------------------------------------------------------ render */

function render() {
  trip = store.activeTrip();

  const picker = $('#trip-picker');
  picker.innerHTML = store.getState().trips
    .map(t => `<option value="${t.id}" ${t.id === trip.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');

  const v = verdict(trip);
  const vb = $('#verdict');
  vb.textContent = v.text;
  vb.className = 'verdict ' + v.tone;

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === ui.tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p.id === 'panel-' + ui.tab));

  if (ui.tab === 'people') renderPeople();
  if (ui.tab === 'when') { renderProbe(); renderLog(); renderResults(); }
  if (ui.tab === 'ask') renderAsk();
}

/* ------------------------------------------------------------------ events */

function findPerson(node) {
  const card = node.closest('[data-pid]');
  return card ? trip.participants.find(p => p.id === card.dataset.pid) : null;
}

function uniqSorted(a) { return [...new Set(a)].sort(); }

function applyPatch(p, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'blackouts' || k === 'onlyDates') p[k] = uniqSorted([...p[k], ...v]);
    else if (k === 'blackoutRanges') p[k] = [...p[k], ...v];
    else p[k] = v;
  }
}

document.addEventListener('click', e => {
  const btn = e.target.closest('button');

  if (e.target.closest('.tab')) {
    ui.tab = e.target.closest('.tab').dataset.tab;
    render();
    return;
  }
  if (!btn) return;
  const act = btn.dataset.act;

  // --- weekday pickers (person + probe) ---
  const dayWrap = btn.closest('.daypicker');
  if (dayWrap && btn.dataset.wd !== undefined) {
    const wd = Number(btn.dataset.wd);
    if (dayWrap.id === 'probe-days' || dayWrap.parentElement?.closest('.probe')) {
      ui.probeDays.has(wd) ? ui.probeDays.delete(wd) : ui.probeDays.add(wd);
      renderProbe();
    } else {
      const p = findPerson(btn);
      if (!p) return;
      const cur = new Set(p.weekdays.length ? p.weekdays : [0, 1, 2, 3, 4, 5, 6]);
      cur.has(wd) ? cur.delete(wd) : cur.add(wd);
      p.weekdays = cur.size === 7 ? [] : [...cur].sort((a, b) => a - b);
      store.save();
    }
    return;
  }

  const p = findPerson(btn);

  switch (act) {
    case 'toggle':
      ui.openPeople.has(p.id) ? ui.openPeople.delete(p.id) : ui.openPeople.add(p.id);
      render(); break;

    case 'status':
      p.status = btn.dataset.status;
      store.save(); break;

    case 'add-blackout': {
      const input = btn.closest('.inline-add').querySelector('[data-act="blackout-input"]');
      if (input.value) { p.blackouts = uniqSorted([...p.blackouts, input.value]); input.value = ''; store.save(); }
      break;
    }
    case 'rm-blackout':
      p.blackouts = p.blackouts.filter(d => d !== btn.dataset.val); store.save(); break;
    case 'rm-range':
      p.blackoutRanges = p.blackoutRanges.filter((_, i) => i !== Number(btn.dataset.val)); store.save(); break;

    case 'add-only': {
      const input = btn.closest('.inline-add').querySelector('[data-act="only-input"]');
      if (input.value) { p.onlyDates = uniqSorted([...p.onlyDates, input.value]); input.value = ''; store.save(); }
      break;
    }
    case 'rm-only':
      p.onlyDates = p.onlyDates.filter(d => d !== btn.dataset.val); store.save(); break;

    case 'parse': {
      const ta = btn.closest('.person-detail').querySelector('[data-act="note"]');
      p.note = ta.value;
      ui.suggestions.set(p.id, parseReply(p.note, trip.window));
      store.save(); break;
    }
    case 'apply-sugg': {
      const sugg = ui.suggestions.get(p.id);
      applyPatch(p, sugg.suggestions[Number(btn.dataset.idx)].patch);
      sugg.suggestions.splice(Number(btn.dataset.idx), 1);
      store.save(); break;
    }
    case 'apply-status': {
      p.status = btn.dataset.status;
      const sugg = ui.suggestions.get(p.id);
      if (sugg) sugg.status = null;
      store.save(); break;
    }
    case 'remove-person':
      trip.participants = trip.participants.filter(x => x.id !== p.id);
      ui.openPeople.delete(p.id); ui.suggestions.delete(p.id);
      store.save(); break;

    case 'toggle-date':
      ui.openDates.has(btn.dataset.date) ? ui.openDates.delete(btn.dataset.date) : ui.openDates.add(btn.dataset.date);
      renderResults(); break;

    case 'toggle-all-dates':
      ui.showAllDates = !ui.showAllDates; renderResults(); break;

    case 'rm-hypothesis':
      trip.hypotheses = trip.hypotheses.filter(h => h.id !== btn.dataset.id);
      store.save(); break;

    case 'copy': {
      const ta = document.getElementById(btn.dataset.target);
      const flag = document.querySelector(`[data-copied="${btn.dataset.target}"]`);
      const done = () => { flag.hidden = false; setTimeout(() => { flag.hidden = true; }, 1600); };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(ta.value).then(done, () => { ta.select(); document.execCommand('copy'); done(); });
      } else { ta.select(); document.execCommand('copy'); done(); }
      break;
    }
  }
});

// Text inputs. These save on every keystroke but do NOT re-render — a
// re-render rebuilds the DOM and the caret jumps out of the field. The
// deferred render on blur/change catches the summary chips up.
document.addEventListener('input', e => {
  const act = e.target.dataset.act;
  const p = findPerson(e.target);
  if (act === 'rename' && p) { p.name = e.target.value; store.saveQuiet(); }
  if (act === 'notice' && p) { p.noticeDays = Math.max(0, Number(e.target.value) || 0); store.saveQuiet(); }
  if (act === 'note' && p) { p.note = e.target.value; store.saveQuiet(); }
  if (e.target.id === 'trip-title') { trip.title = e.target.value; store.saveQuiet(); }
}, true);

document.addEventListener('change', e => {
  if (['rename', 'notice', 'note'].includes(e.target.dataset.act) || e.target.id === 'trip-title') render();
}, true);
$('#win-start').addEventListener('change', e => {
  trip.window.start = e.target.value || todayYMD();
  if (daysBetween(trip.window.start, trip.window.end) < 0) trip.window.end = trip.window.start;
  store.save();
});
$('#win-end').addEventListener('change', e => {
  trip.window.end = e.target.value || addDays(trip.window.start, 30);
  if (daysBetween(trip.window.start, trip.window.end) < 0) trip.window.start = trip.window.end;
  store.save();
});

$('#add-person').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#new-name');
  const name = input.value.trim();
  if (!name) return;
  const p = store.blankParticipant(name);
  trip.participants.push(p);
  ui.openPeople.add(p.id);
  input.value = '';
  store.save();
});

$('#probe-run').addEventListener('click', () => {
  if (!ui.probeDays.size) return;
  const days = [...ui.probeDays].sort((a, b) => a - b);
  const r = evaluateHypothesis(trip, days);
  trip.hypotheses.push({
    id: 'h-' + Math.random().toString(36).slice(2, 9),
    weekdays: days,
    label: days.map(w => WEEKDAY_LONG[w] + 's').join(' & '),
    testedOn: todayYMD(),
    candidateCount: r.candidateCount,
    fullCount: r.fullCoverageDates.length,
    bestDate: r.best ? r.best.date : null,
    bestIn: r.best ? r.best.in.length : 0,
    activeCount: r.activeCount,
  });
  store.save();
});
$('#probe-clear').addEventListener('click', () => { ui.probeDays.clear(); renderProbe(); });

$('#trip-picker').addEventListener('change', e => {
  ui.openPeople.clear(); ui.openDates.clear(); ui.suggestions.clear();
  store.setActive(e.target.value);
});

/* -------------------------------------------------------------------- menu */

const dialog = $('#menu-dialog');
$('#menu-btn').addEventListener('click', () => dialog.showModal());
$('#act-new').addEventListener('click', () => {
  const title = prompt('What are you planning?', 'New trip');
  if (title !== null) { store.addTrip(title.trim() || 'New trip'); dialog.close(); }
});
$('#act-rename').addEventListener('click', () => {
  const title = prompt('Rename trip', trip.title);
  if (title !== null) { trip.title = title.trim() || trip.title; store.save(); dialog.close(); }
});
$('#act-delete').addEventListener('click', () => {
  if (confirm(`Delete "${trip.title}" and everything in it?`)) { store.deleteTrip(trip.id); dialog.close(); }
});
$('#act-export').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `can-you-join-${todayYMD()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#act-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then(t => { store.importJSON(t); dialog.close(); })
    .catch(err => alert('Could not import that file: ' + err.message));
  e.target.value = '';
});
$('#act-demo').addEventListener('click', () => { loadDemo(); dialog.close(); });

/* -------------------------------------------------------------------- demo */

function loadDemo() {
  const t = store.addTrip('Kayak to see the bats');
  const start = todayYMD();
  t.window = { start, end: '2026-09-30' < start ? addDays(start, 45) : '2026-09-30' };
  const mk = (name, status, extra) => Object.assign(store.blankParticipant(name), { status }, extra);
  t.participants = [
    mk('Greg', 'yes', { note: 'yes, any day works for me' }),
    mk('Sara', 'yes', { weekdays: [6], note: 'yes but only Saturdays work here' }),
    mk('Dev', 'maybe', { weekdays: [1, 3], note: 'maybe, depends on day and week — my partner can only do Mondays and Wednesdays' }),
    mk('Ana', 'yes', { noticeDays: 14, note: 'in! just need two weeks notice for the sitter' }),
    mk('Marco', 'maybe', { weekdays: [0, 5, 6], note: 'maybe — weekends or Fridays, and not the week of the 14th' }),
  ];
  ui.tab = 'when';
  ui.openPeople.clear(); ui.openDates.clear(); ui.suggestions.clear();
  store.save();
}

/* -------------------------------------------------------------------- boot */

store.load();
store.onChange(render);
render();

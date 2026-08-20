import {
  WEEKDAY_LONG, WEEKDAY_MIN, WEEKDAY_SHORT,
  todayYMD, addDays, fmtShort, fmtLong, fmtRange, eachDay, daysBetween,
} from './dates.js';
import {
  rankDates, weekdaySummary, blockerAnalysis, bestSplit, verdict,
  activeParticipants, activityView, compareActivities, unlockOpportunities,
  silentParticipants, REASON_LABEL,
} from './solver.js';
import { parseReply } from './parse.js';
import * as api from './api.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  slug: null,
  plan: null,
  me: null,            // { participantId, token, name }
  tab: 'you',
  activityId: null,    // which activity the When tab is showing
  suggestions: null,   // parse result for my own note
  openDates: new Set(),
  busy: false,
  lastPulse: null,
};

const meRow = () => state.plan?.participants.find(p => p.id === state.me?.participantId) || null;
const shareURL = () => `${location.origin}${location.pathname}?p=${state.slug}`;

function toast(msg, bad = false) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function guard(fn) {
  if (state.busy) return;
  state.busy = true;
  try { await fn(); }
  catch (e) { console.error(e); toast(e.message || 'Something went wrong', true); }
  finally { state.busy = false; }
}

/* ===================================================================== load */

async function refresh({ quiet = false } = {}) {
  const plan = await api.getPlan(state.slug);
  if (!plan) {
    $('#view-plan').hidden = true;
    $('#loading').hidden = true;
    $('#view-landing').hidden = false;
    toast('That plan link does not resolve to anything.', true);
    return;
  }
  state.plan = plan;
  if (!state.activityId || !plan.activities.some(a => a.id === state.activityId)) {
    state.activityId = compareActivities(plan)[0]?.activity.id || null;
  }
  if (!quiet) render();
  else renderIfIdle();
}

/** Background poll shouldn't yank a field out from under someone mid-type. */
function renderIfIdle() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  render();
}

/* ================================================================== landing */

function renderLanding() {
  $('#view-landing').hidden = false;
  $('#view-plan').hidden = true;
  $('#loading').hidden = true;
  $('#verdict').hidden = true;
  $('#share-btn').hidden = true;
  $('#mode-pill').hidden = true;

  const known = api.knownPlans();
  $('#known-plans').innerHTML = known.length ? `
    <div class="card">
      <h3>Plans you're in</h3>
      <div style="margin-top:.4rem">
        ${known.map(k => `
          <a class="planlink" href="?p=${encodeURIComponent(k.slug)}">
            <b>${esc(k.title || k.slug)}</b><span>as ${esc(k.name || 'you')}</span></a>`).join('')}
      </div>
    </div>` : '';

  if (!$('#c-start').value) {
    $('#c-start').value = todayYMD();
    $('#c-end').value = addDays(todayYMD(), 45);
  }
}

/* ============================================================== plan header */

function renderHead() {
  const p = state.plan;
  const days = eachDay(p.window.start, p.window.end).filter(d => daysBetween(todayYMD(), d) >= 0);
  $('#plan-head').innerHTML = `
    <div class="card planhead">
      <h2>${esc(p.title)}</h2>
      <p class="hint">${esc(fmtRange(p.window.start, p.window.end))} ·
        ${days.length} candidate day${days.length === 1 ? '' : 's'} ·
        ${p.participants.length} ${p.participants.length === 1 ? 'person' : 'people'} ·
        ${p.activities.length} ${p.activities.length === 1 ? 'idea' : 'ideas'}</p>
    </div>`;

  const pill = $('#mode-pill');
  pill.hidden = false;
  pill.textContent = api.isShared ? 'shared' : 'this browser only';
  pill.className = 'pill' + (api.isShared ? ' good' : '');
  pill.title = api.isShared
    ? 'Everyone with the link sees the same plan.'
    : 'Supabase is not configured, so this plan lives only in this browser. See SETUP.md.';
  $('#share-btn').hidden = false;
}

/* =================================================================== gating */

function renderJoinGate() {
  const gate = $('#join-gate');
  const unclaimed = state.plan.participants.filter(p => !p.claimed);
  gate.hidden = false;
  $('#plan-tabs').hidden = true;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-active'));

  gate.innerHTML = `
    <div class="card">
      <h3>Who are you?</h3>
      ${unclaimed.length ? `
        <p class="hint">Someone already put these names down. Tap yours.</p>
        <div class="sugg-list" style="margin-top:.5rem">
          ${unclaimed.map(p => `<button class="sugg" data-act="claim" data-name="${esc(p.name)}">${esc(p.name)}</button>`).join('')}
        </div>
        <p class="hint" style="margin-top:.7rem">Not listed?</p>` : ''}
      <form id="join-form" class="inline-add" style="margin-top:.4rem">
        <input id="join-name" type="text" placeholder="Your name" autocomplete="given-name" required>
        <button type="submit" class="btn btn-primary">Join</button>
      </form>
      <p class="hint">Your answers stay editable on this device — no password, no email.</p>
    </div>`;
}

/* ================================================================= You tab */

function interestButtons(activityId, level) {
  const opts = [['yes', 'In'], ['maybe', 'Maybe'], ['no', 'Out']];
  return `<div class="statusgroup">
    ${opts.map(([v, label]) => `<button data-act="interest" data-activity="${activityId}"
        data-status="${v}" aria-pressed="${level === v}">${label}</button>`).join('')}
  </div>`;
}

function renderYou() {
  const me = meRow();
  if (!me) return;
  const p = state.plan;

  const activities = p.activities.map(a => {
    const mine = me.interests?.[a.id]?.level || 'pending';
    const others = p.participants.filter(x => x.id !== me.id);
    const yes = others.filter(x => x.interests?.[a.id]?.level === 'yes').length;
    return `
      <div class="card actline">
        <div class="person-head">
          <div style="flex:1;min-width:0">
            <b>${esc(a.title)}</b>
            ${a.detail ? `<div class="hint">${esc(a.detail)}</div>` : ''}
            <div class="hint">${a.proposedBy ? `proposed by ${esc(a.proposedBy)} · ` : ''}${yes} other${yes === 1 ? '' : 's'} in</div>
          </div>
          ${interestButtons(a.id, mine)}
        </div>
      </div>`;
  }).join('');

  $('#panel-you').innerHTML = `
    <div class="card">
      <h3>You're in as ${esc(me.name)}</h3>
      <p class="hint">Wrong person? <button class="linkbtn" data-act="switch-identity">switch</button></p>
    </div>

    <h3 class="sectionhead">What are you up for?</h3>
    ${activities || '<div class="card empty">No ideas yet — add one on the Group tab.</div>'}

    <h3 class="sectionhead">When could you go?</h3>
    <div class="card">
      <p class="hint">You give this once. It applies to every idea above.</p>
      <div class="field" style="margin-top:.6rem">
        <span>Days of the week that work</span>
        <div class="daypicker" data-act="weekdays">
          ${WEEKDAY_MIN.map((m, i) => `<button data-wd="${i}" aria-label="${WEEKDAY_LONG[i]}"
            aria-pressed="${!me.weekdays.length || me.weekdays.includes(i)}">${m}</button>`).join('')}
        </div>
        <p class="hint">${!me.weekdays.length || me.weekdays.length === 7
          ? 'Any day works for you.' : 'Only the highlighted days.'}</p>
      </div>

      <div class="field">
        <span>Dates you can't do</span>
        <div class="datechips">
          ${me.blackouts.map(d => `<span class="datechip">${esc(fmtShort(d))}
            <button data-act="rm-blackout" data-val="${d}" aria-label="Remove">×</button></span>`).join('')}
          ${(me.blackoutRanges || []).map((r, i) => `<span class="datechip">${esc(fmtRange(r.start, r.end))}
            <button data-act="rm-range" data-val="${i}" aria-label="Remove">×</button></span>`).join('')}
        </div>
        <div class="inline-add">
          <input type="date" data-act="blackout-input" min="${p.window.start}" max="${p.window.end}">
          <button class="btn btn-sm" data-act="add-blackout">Block it</button>
        </div>
      </div>

      <div class="field">
        <span>Only these dates work</span>
        <div class="datechips">
          ${me.onlyDates.map(d => `<span class="datechip only">${esc(fmtShort(d))}
            <button data-act="rm-only" data-val="${d}" aria-label="Remove">×</button></span>`).join('')}
        </div>
        <div class="inline-add">
          <input type="date" data-act="only-input" min="${p.window.start}" max="${p.window.end}">
          <button class="btn btn-sm" data-act="add-only">Add</button>
        </div>
        <p class="hint">Leave empty unless your options really are that narrow.</p>
      </div>

      <div class="field">
        <span>Advance notice you need</span>
        <div class="inline-add">
          <input type="number" min="0" max="365" step="1" value="${me.noticeDays}" data-act="notice" style="width:5rem">
          <label>days</label>
        </div>
      </div>
    </div>

    <h3 class="sectionhead">Say it in your own words</h3>
    <div class="card">
      <p class="hint">Type it the way you'd text it. Shmaybe reads it and offers to fill
        the boxes above — including things that would <em>let</em> you come, not just
        things that stop you.</p>
      <div class="field" style="margin-top:.5rem">
        <textarea data-act="note" placeholder="only Saturdays really work, but I could do a Monday if we start after 5">${esc(me.note)}</textarea>
      </div>
      <button class="btn btn-sm btn-primary" data-act="parse">Read it &amp; suggest</button>
      ${state.suggestions ? suggestionBlock(me, state.suggestions) : ''}
    </div>

    ${renderMyUnlocks(me)}`;
}

function renderMyUnlocks(me) {
  const list = me.unlocks || [];
  return `
    <h3 class="sectionhead">Your offers</h3>
    <div class="card">
      <p class="hint">Conditional yeses. These don't make a date work — they tell the
        group what to solve to <em>make</em> it work.</p>
      ${list.length ? `<div style="margin-top:.5rem">${list.map(u => `
        <div class="unlockrow">
          <div>
            <b>${u.weekdays?.length ? esc(u.weekdays.map(w => WEEKDAY_LONG[w] + 's').join(' & '))
                : u.dates?.length ? esc(u.dates.map(fmtShort).join(', ')) : 'Any date'}</b>
            <span>if ${esc(u.condition)}</span>
          </div>
          <button class="rm" data-act="rm-unlock" data-val="${esc(u.id)}" aria-label="Remove">×</button>
        </div>`).join('')}</div>` : '<p class="hint" style="margin-top:.5rem">None yet.</p>'}
      <div class="inline-add" style="margin-top:.5rem">
        <input type="text" data-act="unlock-text" placeholder="I could do Mondays if someone can carpool" style="flex:1;min-width:11rem">
        <button class="btn btn-sm" data-act="add-unlock">Add offer</button>
      </div>
    </div>`;
}

function suggestionBlock(me, sugg) {
  if (!sugg.suggestions.length) {
    return `<div class="suggestions"><h4>Nothing recognised</h4>
      <p class="hint">No constraints found in that — set them by hand above.</p></div>`;
  }
  return `
    <div class="suggestions">
      <h4>Tap what's right</h4>
      <div class="sugg-list">
        ${sugg.suggestions.map((s, i) => `
          <button class="sugg" data-act="apply-sugg" data-idx="${i}">
            ${esc(s.label)}<small>${esc(s.detail)}</small></button>`).join('')}
      </div>
    </div>`;
}

/* =============================================================== Group tab */

function renderGroup() {
  const p = state.plan;
  const me = meRow();

  const roster = p.participants.map(x => {
    const chips = [];
    if (x.weekdays.length && x.weekdays.length < 7) chips.push(x.weekdays.map(w => WEEKDAY_SHORT[w]).join(', ') + ' only');
    if (x.onlyDates.length) chips.push('only ' + x.onlyDates.map(fmtShort).join(', '));
    const blocked = x.blackouts.length + (x.blackoutRanges?.length || 0);
    if (blocked) chips.push(`${blocked} blackout${blocked === 1 ? '' : 's'}`);
    if (x.noticeDays > 0) chips.push(`${x.noticeDays}d notice`);
    (x.unlocks || []).forEach(u => chips.push(`offer: if ${u.condition}`));

    const interests = p.activities.map(a => {
      const lvl = x.interests?.[a.id]?.level || 'pending';
      return `<span class="ichip ${lvl}" title="${esc(a.title)}">${esc(a.title)}<i>${
        { yes: 'in', maybe: 'maybe', no: 'out', pending: '—' }[lvl]}</i></span>`;
    }).join('');

    return `
      <div class="card person">
        <div class="person-head">
          <b style="flex:1">${esc(x.name)}${x.id === me?.id ? ' <span class="pill">you</span>' : ''}</b>
          ${!x.claimed ? '<span class="pill">not joined</span>' : ''}
        </div>
        ${interests ? `<div class="ichips">${interests}</div>` : ''}
        <div class="person-summary">
          ${chips.length ? chips.map(c => `<span class="constraint-chip">${esc(c)}</span>`).join('')
                        : '<span class="constraint-chip free">no limits given</span>'}
        </div>
        ${x.note ? `<p class="quote">“${esc(x.note)}”</p>` : ''}
      </div>`;
  }).join('');

  $('#panel-group').innerHTML = `
    <div class="card">
      <h3>Invite people</h3>
      <p class="hint">One link, no signup. They pick their name and fill in their own availability.</p>
      <div class="inline-add" style="margin-top:.5rem">
        <button class="btn btn-primary btn-sm" data-act="open-share">Share the link</button>
      </div>
    </div>

    <h3 class="sectionhead">Ideas on the table</h3>
    ${p.activities.map(a => `
      <div class="card actline">
        <div class="person-head">
          <div style="flex:1;min-width:0">
            <b>${esc(a.title)}</b>
            ${a.detail ? `<div class="hint">${esc(a.detail)}</div>` : ''}
            <div class="hint">${a.proposedBy ? `proposed by ${esc(a.proposedBy)}` : ''}</div>
          </div>
          ${a.proposedBy === me?.name
            ? `<button class="rm" data-act="archive-activity" data-val="${a.id}" title="Retire this idea">×</button>` : ''}
        </div>
      </div>`).join('') || '<div class="card empty">No ideas yet.</div>'}

    <div class="card">
      <h3>Propose an alternative</h3>
      <p class="hint">Anyone can. It gets scored against the others, so a second idea
        that more people can make will show up as the better plan.</p>
      <form id="add-activity" style="margin-top:.5rem">
        <label class="field"><span>What is it?</span>
          <input id="a-title" type="text" placeholder="River hike instead" required></label>
        <label class="field"><span>Anything to add? (optional)</span>
          <input id="a-detail" type="text" placeholder="easier, no boats needed"></label>
        <button type="submit" class="btn btn-primary btn-sm">Add it</button>
      </form>
    </div>

    <h3 class="sectionhead">Everyone</h3>
    ${roster}

    <div class="card">
      <h3>Plan settings</h3>
      <label class="field"><span>Title</span>
        <input id="p-title" type="text" value="${esc(p.title)}"></label>
      <div class="field-row">
        <label class="field"><span>No earlier than</span>
          <input id="p-start" type="date" value="${p.window.start}"></label>
        <label class="field"><span>No later than</span>
          <input id="p-end" type="date" value="${p.window.end}"></label>
      </div>
      <button class="btn btn-sm" data-act="save-plan">Save</button>
    </div>`;
}

/* ================================================================ When tab */

function dateRow(s, view, total) {
  const open = state.openDates.has(s.date);
  const pct = Math.round(s.coverage * 100);
  const name = id => esc(view.participants.find(x => x.id === id)?.name || '?');
  const why = open ? `
    <div class="daterow-why">
      ${s.in.length ? `<b>In:</b> ${s.in.map(name).join(', ')}<br>` : ''}
      ${s.out.length ? `<b>Out:</b> ${s.out.map(o => `${name(o.id)} — ${REASON_LABEL[o.reason]}`).join('; ')}`
                     : '<b>Everyone can make it.</b>'}
      ${s.unlockable.length ? `<br><b>Could be in:</b> ${s.unlockable
        .map(u => `${name(u.id)} if ${esc(u.condition)}`).join('; ')}` : ''}
    </div>` : '';
  return `
    <button class="daterow ${s.everyone ? 'full' : ''} ${!s.everyone && s.everyoneIfUnlocked ? 'unlockable' : ''}"
            data-act="toggle-date" data-date="${s.date}">
      <span class="daterow-date">${esc(fmtShort(s.date))}</span>
      <span class="daterow-bar"><i style="width:${pct}%"></i></span>
      <span class="daterow-count">${s.in.length}/${total}</span>
    </button>${why}`;
}

function renderWhen() {
  const p = state.plan;
  const box = $('#panel-when');

  if (!p.activities.length) {
    box.innerHTML = '<div class="card empty">Add an idea on the Group tab first.</div>';
    return;
  }

  const board = compareActivities(p);
  const chosen = board.find(b => b.activity.id === state.activityId) || board[0];
  const view = chosen.view;
  const active = activeParticipants(view);
  const ranked = rankDates(view);
  const full = ranked.filter(s => s.everyone);
  const opportunities = unlockOpportunities(view);
  const blockers = blockerAnalysis(view).filter(b => b.blocks > 0);
  const split = bestSplit(view);
  const rollup = weekdaySummary(view);

  let html = '';

  // --- the comparison, which is the whole point of multiple activities ---
  if (board.length > 1) {
    html += `
      <div class="card">
        <h2>Which idea travels furthest</h2>
        <p class="hint">Same people, same calendar — only the appetite differs. Tap one to dig in.</p>
        <table class="rollup" style="margin-top:.4rem">
          <thead><tr><th>Idea</th><th class="num">In</th><th class="num">Best date</th><th class="num">All-in</th></tr></thead>
          <tbody>
            ${board.map(b => `
              <tr class="${b.activity.id === chosen.activity.id ? 'sel' : ''} ${b.fullCoverageDates.length ? 'win' : ''}"
                  data-act="pick-activity" data-val="${b.activity.id}">
                <td>${esc(b.activity.title)}</td>
                <td class="num">${b.yesCount}${b.maybeCount ? `+${b.maybeCount}?` : ''}</td>
                <td class="num">${b.best ? `${b.bestIn}/${b.activeCount}` : '—'}</td>
                <td class="num">${b.fullCoverageDates.length}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  html += `<h3 class="sectionhead">${esc(chosen.activity.title)}</h3>`;

  if (!active.length) {
    html += `<div class="card empty">Nobody has said they're in for this one yet.</div>`;
    box.innerHTML = html;
    return;
  }

  html += `
    <div class="card">
      <h2>Best dates${full.length ? ` · ${full.length} work${full.length === 1 ? 's' : ''} for everyone` : ''}</h2>
      <p class="hint">A <em>maybe</em> counts a bit less than a <em>yes</em>. Tap a row for the reasons.</p>
      <div style="margin-top:.5rem">${ranked.slice(0, 8).map(s => dateRow(s, view, active.length)).join('')
        || '<p class="hint">No dates left in the window.</p>'}</div>
    </div>`;

  // --- the offers, turned into a to-do list ---
  if (opportunities.length) {
    html += `
      <div class="card">
        <h2>What would unlock more</h2>
        <p class="hint">These dates work for <em>everyone</em> the moment somebody solves the condition.</p>
        <div style="margin-top:.5rem">
          ${opportunities.slice(0, 4).map(o => `
            <div class="opp">
              <b>${o.dates.slice(0, 3).map(fmtShort).join(', ')}${o.dates.length > 3 ? ` +${o.dates.length - 3} more` : ''}</b>
              <span>needs: ${o.conditions.map(c =>
                `${esc(view.participants.find(x => x.id === c.id)?.name || '?')} — ${esc(c.condition)}`).join(' · ')}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  html += `
    <div class="card">
      <h2>Which weekday to chase</h2>
      <table class="rollup">
        <thead><tr><th>Day</th><th class="num">Dates</th><th class="num">Best</th><th class="num">All-in</th></tr></thead>
        <tbody>
          ${rollup.map(r => `
            <tr class="${r.fullCoverageDates.length ? 'win' : ''}">
              <td>${esc(r.label)}s</td><td class="num">${r.candidateCount}</td>
              <td class="num">${r.best.in.length}/${active.length}</td>
              <td class="num">${r.fullCoverageDates.length}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  if (blockers.length) {
    html += `
      <div class="card">
        <h2>Who is costing you dates</h2>
        <p class="hint">“Sole blocker” means everyone else was free.</p>
        <div style="margin-top:.5rem">
          ${blockers.map(b => {
            const reasons = Object.entries(b.soleByReason).map(([r, n]) => `${n}× ${REASON_LABEL[r]}`).join(', ');
            return `<div class="blocker"><b>${esc(b.name)}</b>
              <span>free on ${b.availableOn} of ${b.availableOn + b.blocks}${
                b.soleBlocks ? ` · <strong>sole blocker on ${b.soleBlocks}</strong>${reasons ? ` (${esc(reasons)})` : ''}` : ''}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  if (split) {
    const name = id => esc(view.participants.find(x => x.id === id)?.name || '?');
    html += `
      <div class="card">
        <h2>Or run it twice</h2>
        <p class="hint">These two together reach ${split.union.size} of ${active.length}.</p>
        <div style="margin-top:.5rem">
          <div class="split-leg"><b>${esc(fmtLong(split.a.date))}</b> — ${split.a.in.map(name).join(', ')}</div>
          <div class="split-leg"><b>${esc(fmtLong(split.b.date))}</b> — ${split.b.in.map(name).join(', ')}</div>
        </div>
      </div>`;
  }

  box.innerHTML = html;
}

/* ================================================================= Ask tab */

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
  const p = state.plan;
  const board = compareActivities(p);
  const chosen = board.find(b => b.activity.id === state.activityId) || board[0];
  const silent = silentParticipants(p);
  let html = '';

  html += draft('d-invite', 'Invite people',
    'The opener. The link does the asking, so you never collect answers by text again.',
    `Trying to sort out ${p.title} — ${fmtRange(p.window.start, p.window.end)}.\n\n` +
    `Tap here, put in when you can go, and say what you're up for:\n${shareURL()}\n\n` +
    `Takes a minute. No signup, and you can change it later.`);

  if (silent.length) {
    html += draft('d-chase', 'Chase the quiet ones',
      `${silent.length} ${silent.length === 1 ? 'person hasn\'t' : 'people haven\'t'} weighed in on anything yet.`,
      `Hey ${silent.map(x => x.name).join(', ')} — still need you for ${p.title}. ` +
      `Even a "maybe" moves it along: ${shareURL()}`);
  }

  if (chosen && chosen.activeCount) {
    const view = chosen.view;
    const ranked = rankDates(view);
    const full = ranked.filter(s => s.everyone);
    const name = id => view.participants.find(x => x.id === id)?.name || '?';

    if (full.length) {
      html += draft('d-lock', 'Lock it in',
        `These clear every constraint on record for ${chosen.activity.title}.`,
        `Good news — ${full.slice(0, 3).map(s => fmtShort(s.date)).join(', ')} work for everyone ` +
        `for ${chosen.activity.title}.\n\nI'm leaning ${fmtLong(full[0].date)}. Any objection before I book it?`);
    } else if (ranked.length) {
      const picks = ranked.slice(0, 3);
      html += draft('d-narrow', 'Narrow it down',
        'Nothing catches everyone, so offer the best few and name the sticking point.',
        `No single date works for all of us on ${chosen.activity.title}. Closest three:\n\n` +
        picks.map(s => `• ${fmtLong(s.date)} — ${s.in.map(name).join(', ')}`).join('\n') +
        `\n\nCan anyone stretch? Otherwise I'll go with ${fmtLong(picks[0].date)}.`);
    }

    // The unlock nudge — the ask that actually changes the answer.
    for (const o of unlockOpportunities(view).slice(0, 2)) {
      const who = o.conditions.map(c => name(c.id)).join(' & ');
      html += draft(`d-unlock-${o.dates[0]}`, `Solve it for ${who}`,
        `${o.dates.length} date${o.dates.length === 1 ? '' : 's'} go to full turnout if this gets sorted.`,
        `We're one thing away from all of us making ${chosen.activity.title} on ` +
        `${o.dates.slice(0, 3).map(fmtShort).join(' / ')}.\n\n` +
        o.conditions.map(c => `${name(c.id)} needs: ${c.condition}`).join('\n') +
        `\n\nCan anyone help with that?`);
    }

    const blockers = blockerAnalysis(view).filter(b => b.soleBlocks > 0);
    for (const b of blockers.slice(0, 1)) {
      const reason = Object.keys(b.soleByReason)[0];
      const ask = {
        weekday: 'is that weekday truly impossible, or just inconvenient?',
        blackout: 'is that date locked in, or could it move?',
        notOnList: 'are there any other dates that could work?',
        notice: 'could you make it work with shorter notice?',
      }[reason] || 'is there any flex there?';
      const dates = ranked.filter(s => s.out.length === 1 && s.out[0].id === b.id)
        .slice(0, 3).map(s => fmtShort(s.date));
      html += draft(`d-blocker-${b.id}`, `Ask ${b.name} directly`,
        `Everything else lines up on ${b.soleBlocks} date${b.soleBlocks === 1 ? '' : 's'} — only ${esc(b.name)} can't.`,
        `Hey ${b.name} — ${dates.join(', ')} work for everyone else. ` +
        `${ask.charAt(0).toUpperCase() + ask.slice(1)} Totally fine either way, I just want to know before I pick.`);
    }

    // Only worth suggesting when a different idea genuinely does better.
    const better = board.find(b => b.activity.id !== chosen.activity.id && b.reach > chosen.reach);
    if (better) {
      html += draft('d-switch', 'Suggest the other idea',
        `${better.activity.title} reaches ${better.reach} people against ${chosen.reach} for ${chosen.activity.title}.`,
        `Heads up — ${chosen.activity.title} tops out at ${chosen.reach} of us, but ` +
        `${better.activity.title} gets ${better.reach}${better.best ? ` on ${fmtLong(better.best.date)}` : ''}.\n\n` +
        `Want to switch? Same link: ${shareURL()}`);
    }
  }

  $('#panel-ask').innerHTML = html;
}

/* ================================================================== render */

function render() {
  if (!state.plan) return renderLanding();

  $('#view-landing').hidden = true;
  $('#view-plan').hidden = false;
  $('#loading').hidden = true;

  renderHead();

  if (!state.me) return renderJoinGate();
  if (!meRow()) {
    // The token no longer matches anything (plan reset, row removed).
    api.forgetIdentity(state.slug);
    state.me = null;
    return renderJoinGate();
  }

  $('#join-gate').hidden = true;
  $('#plan-tabs').hidden = false;

  const v = verdict(activityView(state.plan, state.activityId));
  const vb = $('#verdict');
  vb.hidden = false;
  vb.textContent = v.text;
  vb.className = 'verdict ' + v.tone;

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === state.tab));
  document.querySelectorAll('.panel').forEach(el => el.classList.toggle('is-active', el.id === 'panel-' + state.tab));

  if (state.tab === 'you') renderYou();
  if (state.tab === 'group') renderGroup();
  if (state.tab === 'when') renderWhen();
  if (state.tab === 'ask') renderAsk();
}

/* =================================================================== saves */

let saveTimer = null;
let pendingPatch = {};

/** Optimistic: change the local row, redraw, then persist. Weekday taps would
 *  feel like treacle at one round trip each. */
function patchMe(patch, { immediate = false } = {}) {
  const me = meRow();
  if (!me) return;
  Object.assign(me, patch);
  Object.assign(pendingPatch, patch);
  render();

  clearTimeout(saveTimer);
  const flush = async () => {
    const body = pendingPatch;
    pendingPatch = {};
    if (!Object.keys(body).length) return;
    try { await api.updateParticipant(state.slug, state.me.token, body); }
    catch (e) { toast(e.message || 'Could not save', true); await refresh(); }
  };
  if (immediate) flush(); else saveTimer = setTimeout(flush, 700);
}

function applyPatch(me, patch) {
  const uniqSorted = a => [...new Set(a)].sort();
  const next = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'blackouts' || k === 'onlyDates') next[k] = uniqSorted([...(me[k] || []), ...v]);
    else if (k === 'blackoutRanges' || k === 'unlocks') next[k] = [...(me[k] || []), ...v];
    else next[k] = v;
  }
  return next;
}

/* =================================================================== events */

document.addEventListener('click', async e => {
  const tab = e.target.closest('.tab');
  if (tab) { state.tab = tab.dataset.tab; state.openDates.clear(); render(); return; }

  const row = e.target.closest('[data-act="pick-activity"]');
  if (row) { state.activityId = row.dataset.val; state.openDates.clear(); render(); return; }

  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  const me = meRow();

  // Weekday picker
  if (btn.dataset.wd !== undefined && btn.closest('.daypicker')) {
    const wd = Number(btn.dataset.wd);
    const cur = new Set(me.weekdays.length ? me.weekdays : [0, 1, 2, 3, 4, 5, 6]);
    cur.has(wd) ? cur.delete(wd) : cur.add(wd);
    patchMe({ weekdays: cur.size === 7 ? [] : [...cur].sort((a, b) => a - b) });
    return;
  }

  switch (act) {
    case 'claim':
      await guard(async () => {
        const id = await api.joinPlan(state.slug, btn.dataset.name);
        state.me = { ...id, name: btn.dataset.name };
        api.rememberIdentity(state.slug, { ...state.me, title: state.plan.title });
        await refresh();
      });
      break;

    case 'switch-identity':
      api.forgetIdentity(state.slug);
      state.me = null;
      render();
      break;

    case 'interest':
      await guard(async () => {
        const level = me.interests?.[btn.dataset.activity]?.level === btn.dataset.status
          ? 'pending' : btn.dataset.status;
        me.interests = { ...(me.interests || {}), [btn.dataset.activity]: { level, note: '' } };
        render();
        await api.setInterest(state.slug, state.me.token, btn.dataset.activity, level, null);
        await refresh({ quiet: true });
      });
      break;

    case 'add-blackout': {
      const input = btn.closest('.inline-add').querySelector('[data-act="blackout-input"]');
      if (input.value) { patchMe(applyPatch(me, { blackouts: [input.value] }), { immediate: true }); }
      break;
    }
    case 'rm-blackout':
      patchMe({ blackouts: me.blackouts.filter(d => d !== btn.dataset.val) }, { immediate: true }); break;
    case 'rm-range':
      patchMe({ blackoutRanges: me.blackoutRanges.filter((_, i) => i !== Number(btn.dataset.val)) }, { immediate: true }); break;
    case 'add-only': {
      const input = btn.closest('.inline-add').querySelector('[data-act="only-input"]');
      if (input.value) { patchMe(applyPatch(me, { onlyDates: [input.value] }), { immediate: true }); }
      break;
    }
    case 'rm-only':
      patchMe({ onlyDates: me.onlyDates.filter(d => d !== btn.dataset.val) }, { immediate: true }); break;
    case 'rm-unlock':
      patchMe({ unlocks: (me.unlocks || []).filter(u => u.id !== btn.dataset.val) }, { immediate: true }); break;

    case 'add-unlock': {
      const input = btn.closest('.inline-add').querySelector('[data-act="unlock-text"]');
      const text = input.value.trim();
      if (!text) break;
      const parsed = parseReply(text, state.plan.window);
      const found = parsed.suggestions.find(s => s.patch.unlocks);
      const unlock = found ? found.patch.unlocks[0]
        : { id: 'u-' + Date.now(), text, condition: text, weekdays: [], dates: [] };
      input.value = '';
      patchMe({ unlocks: [...(me.unlocks || []), unlock] }, { immediate: true });
      break;
    }

    case 'parse': {
      const ta = $('[data-act="note"]');
      state.suggestions = parseReply(ta.value, state.plan.window);
      patchMe({ note: ta.value }, { immediate: true });
      break;
    }
    case 'apply-sugg': {
      const s = state.suggestions.suggestions[Number(btn.dataset.idx)];
      state.suggestions.suggestions.splice(Number(btn.dataset.idx), 1);
      patchMe(applyPatch(me, s.patch), { immediate: true });
      break;
    }

    case 'archive-activity':
      if (!confirm('Retire this idea? Everyone loses the option.')) break;
      await guard(async () => {
        await api.archiveActivity(state.slug, state.me.token, btn.dataset.val);
        await refresh();
      });
      break;

    case 'save-plan':
      await guard(async () => {
        await api.updatePlan(state.slug, state.me.token, $('#p-title').value, $('#p-start').value, $('#p-end').value);
        await refresh();
        toast('Plan updated');
      });
      break;

    case 'toggle-date':
      state.openDates.has(btn.dataset.date) ? state.openDates.delete(btn.dataset.date)
                                            : state.openDates.add(btn.dataset.date);
      renderWhen();
      break;

    case 'open-share': openShare(); break;

    case 'copy': {
      const ta = document.getElementById(btn.dataset.target);
      const flag = document.querySelector(`[data-copied="${btn.dataset.target}"]`);
      copyText(ta.value, () => { if (flag) { flag.hidden = false; setTimeout(() => { flag.hidden = true; }, 1600); } });
      break;
    }
  }
});

document.addEventListener('input', e => {
  const me = meRow();
  if (!me) return;
  if (e.target.dataset.act === 'note') { me.note = e.target.value; pendingPatch.note = e.target.value; scheduleFlush(); }
  if (e.target.dataset.act === 'notice') {
    const n = Math.max(0, Number(e.target.value) || 0);
    me.noticeDays = n; pendingPatch.noticeDays = n; scheduleFlush();
  }
});

function scheduleFlush() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = pendingPatch;
    pendingPatch = {};
    if (!Object.keys(body).length || !state.me) return;
    try { await api.updateParticipant(state.slug, state.me.token, body); }
    catch (err) { toast(err.message || 'Could not save', true); }
  }, 800);
}

function copyText(text, done) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); done();
  }
}

/* ---------------------------------------------------------------- forms --- */

$('#create-plan').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#create-error');
  err.hidden = true;
  await guard(async () => {
    const res = await api.createPlan({
      title: $('#c-title').value.trim(),
      start: $('#c-start').value,
      end: $('#c-end').value,
      activity: $('#c-activity').value.trim(),
      name: $('#c-name').value.trim(),
    });
    state.slug = res.slug;
    state.me = { participantId: res.participantId, token: res.token, name: $('#c-name').value.trim() };
    api.rememberIdentity(res.slug, { ...state.me, title: $('#c-title').value.trim() });
    history.replaceState({}, '', `?p=${res.slug}`);
    await refresh();
    openShare();
  });
});

$('#open-plan').addEventListener('submit', e => {
  e.preventDefault();
  const raw = $('#o-slug').value.trim();
  const slug = (raw.match(/[?&]p=([a-z0-9]+)/i) || [, raw])[1];
  if (slug) location.search = `?p=${encodeURIComponent(slug)}`;
});

document.addEventListener('submit', async e => {
  if (e.target.id === 'join-form') {
    e.preventDefault();
    const name = $('#join-name').value.trim();
    if (!name) return;
    await guard(async () => {
      try {
        const id = await api.joinPlan(state.slug, name);
        state.me = { ...id, name };
        api.rememberIdentity(state.slug, { ...state.me, title: state.plan.title });
        await refresh();
      } catch (err) {
        if (err.taken) toast(`${name} is already taken in this plan — add a last initial.`, true);
        else throw err;
      }
    });
  }
  if (e.target.id === 'add-activity') {
    e.preventDefault();
    await guard(async () => {
      await api.addActivity(state.slug, state.me.token, $('#a-title').value.trim(), $('#a-detail').value.trim());
      await refresh();
      toast('Added — it will be scored against the others.');
    });
  }
});

/* ---------------------------------------------------------------- share --- */

function openShare() {
  $('#share-url').value = shareURL();
  $('#share-dialog').showModal();
}
$('#share-btn').addEventListener('click', openShare);
$('#share-copy').addEventListener('click', () => copyText(shareURL(), () => flashCopied()));
$('#share-sms').addEventListener('click', () => copyText(
  `Trying to sort out ${state.plan.title}. Tap here and put in when you can go — no signup:\n${shareURL()}`,
  () => flashCopied()));
function flashCopied() {
  const f = $('#share-copied');
  f.hidden = false;
  setTimeout(() => { f.hidden = true; }, 1600);
}

/* ----------------------------------------------------------- polling ------ */
// No realtime: the tables are closed to anon, so a subscription can't read them.
// A cheap pulse every 10s while the tab is visible is plenty for this.

async function poll() {
  if (document.hidden || !state.slug || !state.plan) return;
  try {
    const p = await api.pulse(state.slug);
    if (p && p !== state.lastPulse) {
      state.lastPulse = p;
      await refresh({ quiet: true });
    }
  } catch { /* offline; try again next tick */ }
}
setInterval(poll, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ------------------------------------------------------------------ boot -- */

(async function boot() {
  const slug = new URLSearchParams(location.search).get('p');
  if (!slug) { renderLanding(); return; }
  state.slug = slug;
  state.me = api.identity(slug);
  $('#loading').hidden = false;
  try {
    await refresh();
    state.lastPulse = await api.pulse(slug);
  } catch (e) {
    $('#loading').hidden = true;
    renderLanding();
    toast(e.message || 'Could not load that plan', true);
  }
})();

if (api.configError) toast('Sharing is off: ' + api.configError, true);

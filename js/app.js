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
import { renderCalendar, rangeCovering } from './calendar.js';
import { splitThread } from './thread.js';
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
  editingActivity: null,
  editingUnlock: null,
  editingUnlockDays: null,
  editingUnlockText: null,   // held in state: re-rendering the form would drop it
  calMode: 'block',      // what a calendar tap means: 'block' or 'only'
  optOut: null,          // { activityId } — the counter-offer nudge
  invite: null,          // { name, url } — the last invite link generated
  openDates: new Set(),
  busy: false,
  lastPulse: null,
};

const meRow = () => state.plan?.participants.find(p => p.id === state.me?.participantId) || null;
const shareURL = () => `${location.origin}${location.pathname}?p=${state.slug}`;
/** The share link plus your claim token — this is how you move to another
 *  device. It is yours, not the group's; anyone holding it edits as you. */
const personalURL = () => `${shareURL()}&me=${state.me.token}`;
/** Names who it's for, carries no token — safe to paste into a group chat. */
const inviteURL = name => `${shareURL()}&for=${encodeURIComponent(name)}`;

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
  const others = Math.max(0, p.activities.length - 1);
  $('#plan-head').innerHTML = `
    <div class="card planhead">
      <h2>${esc(p.title)}${others ? `<span class="alt"> +${others} alternative${others === 1 ? '' : 's'}</span>` : ''}</h2>
      <p class="hint">${esc(fmtRange(p.window.start, p.window.end))} ·
        ${days.length} candidate day${days.length === 1 ? '' : 's'} ·
        ${p.participants.length} ${p.participants.length === 1 ? 'person' : 'people'}</p>
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
  // An invite link names its recipient, so lead with that name instead of
  // making them find themselves in a list.
  const invited = state.invitedAs
    && unclaimed.find(p => p.name.toLowerCase() === state.invitedAs.toLowerCase());
  gate.hidden = false;
  $('#plan-tabs').hidden = true;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-active'));

  gate.innerHTML = `
    <div class="card">
      ${invited ? `
        <h3>Hi ${esc(invited.name)} — is that you?</h3>
        <div class="sugg-list" style="margin-top:.5rem">
          <button class="sugg" data-act="claim" data-name="${esc(invited.name)}">
            Yes, I'm ${esc(invited.name)}<small>picks up your spot</small></button>
        </div>
        <p class="hint" style="margin-top:.7rem">Somebody else?</p>` : `
      <h3>Who are you?</h3>`}
      ${unclaimed.filter(u => u.id !== invited?.id).length ? `
        ${invited ? '' : '<p class="hint">Someone already put these names down. Tap yours.</p>'}
        <div class="sugg-list" style="margin-top:.5rem">
          ${unclaimed.filter(u => u.id !== invited?.id).map(p =>
            `<button class="sugg" data-act="claim" data-name="${esc(p.name)}">${esc(p.name)}</button>`).join('')}
        </div>
        <p class="hint" style="margin-top:.7rem">Not listed?</p>` : ''}
      <form id="join-form" class="inline-add" style="margin-top:.4rem">
        <input id="join-name" type="text" placeholder="Your name" autocomplete="given-name" required>
        <button type="submit" class="btn btn-primary">Join</button>
      </form>
      <p class="hint">Your answers stay editable on this device — no password, no email.
        Already in this plan on another device? Open the private link from there
        (You → “Open on another device”) instead of joining twice.</p>
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
        ${state.optOut?.activityId === a.id ? counterOffer(a, state.optOut.level) : ''}
      </div>`;
  }).join('');

  $('#panel-you').innerHTML = `
    <div class="card">
      <h3>You're in as ${esc(me.name)}</h3>
      ${state.renaming ? `
        <div class="inline-add" style="margin-top:.4rem">
          <input id="rename-input" type="text" value="${esc(me.name)}" style="flex:1;min-width:8rem">
          <button class="btn btn-sm btn-primary" data-act="rename-save">Save</button>
          <button class="btn btn-sm btn-ghost" data-act="rename-cancel">Cancel</button>
        </div>` : `
        <div class="inline-add" style="margin-top:.4rem">
          <button class="btn btn-sm" data-act="rename-start">Change name</button>
          <button class="btn btn-sm" data-act="copy-personal">Open on another device</button>
          <button class="btn btn-sm btn-danger" data-act="not-me">Not me</button>
        </div>
        <p class="hint">“Open on another device” copies a private link that carries your
          spot with it — don't put that one in the group chat.</p>`}
    </div>

    <h3 class="sectionhead">What are you up for?</h3>
    ${activities || `
      <div class="card">
        <p class="hint">Nobody has suggested anything yet, so there's nothing to say
          yes or no to — that's why the app hasn't asked you. Put the first idea up
          and everyone gets in / maybe / out buttons for it.</p>
        <form data-act="add-activity-form" style="margin-top:.6rem">
          <label class="field"><span>What should we do?</span>
            <input name="title" type="text" placeholder="Kayak to see the bats" required></label>
          <button type="submit" class="btn btn-primary btn-sm">Put it up</button>
        </form>
        <p class="hint">Meanwhile the <b>When</b> tab already works — it's using the
          availability everyone has given.</p>
      </div>`}

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
        <span>Which days work</span>
        ${renderCalendar(me, p, state.calMode)}
        ${(me.blackoutRanges || []).length ? `
          <div class="datechips" style="margin-top:.5rem">
            ${(me.blackoutRanges || []).map((r, i) => `<span class="datechip">${esc(fmtRange(r.start, r.end))}
              <button data-act="rm-range" data-val="${i}" aria-label="Remove">×</button></span>`).join('')}
          </div>` : ''}
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

/**
 * Shown after somebody steps back from an idea. It does not block the change —
 * the change has already been saved — because an app about inclusiveness has no
 * business making it hard to say no. It just points out that "no" is rarely the
 * only true answer: usually there's a condition that would make it a yes, and
 * saying that is more useful to the group than disappearing from the count.
 */
function counterOffer(activity, level) {
  const out = level === 'no';
  return `
    <div class="nudge">
      <b>${out ? `Out for ${esc(activity.title)} — noted.` : `Marked maybe for ${esc(activity.title)}.`}</b>
      <p>${out
        ? `Before you go: is it really the whole idea, or is it the timing? If there's
           something that <em>would</em> make it work, say that instead — the app can
           chase it, and “I could if…” keeps you in the count.`
        : `What's the uncertainty? If you can name it, the group can try to solve it
           rather than guess around you.`}</p>
      <div class="sugg-list">
        <button class="sugg" data-act="nudge-offer">Add an offer<small>“I could, if…”</small></button>
        <button class="sugg" data-act="nudge-dates">Narrow my dates<small>keep me in, fewer days</small></button>
        <button class="sugg" data-act="nudge-dismiss">${out ? "No, I'm out" : 'Leave it vague'}<small>that's fine too</small></button>
      </div>
    </div>`;
}

function renderMyUnlocks(me) {
  const list = me.unlocks || [];
  return `
    <h3 class="sectionhead">Your offers</h3>
    <div class="card">
      <p class="hint">Conditional yeses. These don't make a date work — they tell the
        group what to solve to <em>make</em> it work.</p>
      ${list.length ? `<div style="margin-top:.5rem">${list.map(u => state.editingUnlock === u.id ? `
        <form class="unlockrow" data-act="edit-unlock-form" data-val="${esc(u.id)}">
          <div style="flex:1">
            <input name="condition" type="text"
                   value="${esc(state.editingUnlockText ?? u.condition)}"
                   style="width:100%" aria-label="Condition">
            <div class="daypicker" data-act="unlock-days" data-val="${esc(u.id)}" style="margin-top:.35rem">
              ${WEEKDAY_MIN.map((m, i) => `<button type="button" data-wd="${i}"
                aria-label="${WEEKDAY_LONG[i]}"
                aria-pressed="${(state.editingUnlockDays || []).includes(i)}">${m}</button>`).join('')}
            </div>
            <p class="hint">Pick the days this offer covers, or none for any date.</p>
            <div class="inline-add">
              <button type="submit" class="btn btn-sm btn-primary">Save</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="unlock-cancel">Cancel</button>
            </div>
          </div>
        </form>` : `
        <div class="unlockrow">
          <div style="flex:1">
            <b>${u.weekdays?.length ? esc(u.weekdays.map(w => WEEKDAY_LONG[w] + 's').join(' & '))
                : u.dates?.length ? esc(u.dates.map(fmtShort).join(', ')) : 'Any date'}</b>
            <span>if ${esc(u.condition)}</span>
          </div>
          <button class="btn btn-sm" data-act="edit-unlock" data-val="${esc(u.id)}">Edit</button>
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
          ${!x.claimed ? '<span class="pill">invited</span>' : ''}
          ${!x.claimed ? `<button class="btn btn-sm" data-act="copy-invite-for" data-val="${esc(x.name)}">Link</button>` : ''}
          ${!x.claimed && (me?.id === p.ownerId || x.invitedBy === me?.id)
            ? `<button class="rm" data-act="remove-participant" data-val="${x.id}"
                 data-name="${esc(x.name)}" title="Withdraw this invite">×</button>` : ''}
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
      <p class="hint">One link for the whole group — they pick their name and fill in
        their own availability.</p>
      <div class="inline-add" style="margin-top:.5rem">
        <button class="btn btn-primary btn-sm" data-act="open-share">Share the group link</button>
      </div>
      <p class="hint" style="margin-top:.8rem">Or put a name down and get a link
        addressed to them. Anyone in the plan can — you don't have to be whoever
        started it.</p>
      <form data-act="invite-form" class="inline-add" style="margin-top:.4rem">
        <input name="name" type="text" placeholder="Kelly" autocomplete="off" style="flex:1;min-width:7rem" required>
        <button type="submit" class="btn btn-sm">Make a link</button>
      </form>
      ${state.invite ? `
        <div class="suggestions" style="margin-top:.6rem">
          <h4>Send this to ${esc(state.invite.name)}</h4>
          <input type="text" readonly value="${esc(state.invite.url)}" id="invite-url"
                 style="width:100%;margin-bottom:.4rem">
          <div class="inline-add">
            <button class="btn btn-sm btn-primary" data-act="copy-invite">Copy link</button>
            <button class="btn btn-sm" data-act="copy-invite-text">Copy with a message</button>
            <button class="btn btn-sm btn-ghost" data-act="clear-invite">Done</button>
          </div>
          <p class="hint">It just names them, so it's safe to paste anywhere. They tap
            it and their name is waiting.</p>
        </div>` : ''}
    </div>

    <div class="card">
      <h3>Already got answers by text?</h3>
      <p class="hint">Paste the group thread, or a screenshot of it, and Shmaybe will
        sort out who said what and pull the constraints out. It reads the image on
        this device — nothing is uploaded.</p>
      <div class="inline-add" style="margin-top:.5rem">
        <button class="btn btn-sm" data-act="open-thread">Read a thread</button>
      </div>
    </div>

    <h3 class="sectionhead">On the table</h3>
    ${p.activities.map((a, i) => {
      const mine = !a.proposedBy || a.proposedBy === me?.name;
      const editing = state.editingActivity === a.id;
      return `
      <div class="card actline" data-aid="${a.id}">
        ${editing ? `
          <form data-act="edit-activity-form" data-val="${a.id}">
            <label class="field"><span>What is it?</span>
              <input name="title" type="text" value="${esc(a.title)}" required></label>
            <label class="field"><span>Details (optional)</span>
              <input name="detail" type="text" value="${esc(a.detail)}"
                placeholder="meet at the ramp, bring a headlamp"></label>
            <div class="inline-add">
              <button type="submit" class="btn btn-sm btn-primary">Save</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="edit-cancel">Cancel</button>
            </div>
          </form>` : `
          <div class="person-head">
            <div style="flex:1;min-width:0">
              <b>${esc(a.title)}</b>${i === 0 ? ' <span class="pill">names the plan</span>' : ''}
              ${a.detail ? `<div class="hint">${esc(a.detail)}</div>` : ''}
              <div class="hint">${a.proposedBy ? `put up by ${esc(a.proposedBy)}` : 'came with the plan'}</div>
            </div>
            ${mine ? `<button class="btn btn-sm" data-act="edit-activity" data-val="${a.id}">Edit</button>` : ''}
            ${mine && p.activities.length > 1
              ? `<button class="rm" data-act="archive-activity" data-val="${a.id}" title="Retire this idea">×</button>` : ''}
          </div>`}
      </div>`;
    }).join('') || '<div class="card empty">No ideas yet.</div>'}

    <div class="card">
      <h3>Put up an alternative</h3>
      <p class="hint">Anyone can. It gets scored against the rest, so a second idea
        more people can make will show up as the better plan.</p>
      <form data-act="add-activity-form" style="margin-top:.5rem">
        <label class="field"><span>What is it?</span>
          <input name="title" type="text" placeholder="River hike instead" required></label>
        <label class="field"><span>Anything to add? (optional)</span>
          <input name="detail" type="text" placeholder="easier, no boats needed"></label>
        <button type="submit" class="btn btn-primary btn-sm">Add it</button>
      </form>
    </div>

    <h3 class="sectionhead">Everyone</h3>
    ${roster}

    <div class="card">
      <h3>When could this happen?</h3>
      <p class="hint">The window every idea gets scored inside.</p>
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

  const implicit = !p.activities.length;
  const board = implicit ? [] : compareActivities(p);
  const chosen = implicit ? null : (board.find(b => b.activity.id === state.activityId) || board[0]);
  const view = implicit ? activityView(p, null) : chosen.view;
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

  if (implicit) {
    html += `
      <div class="card">
        <h2>Dates that work for everyone in the plan</h2>
        <p class="hint">Nobody has proposed an activity yet, so this is scored on
          availability alone — everyone in the plan counts as in.
          <button class="linkbtn" data-act="go-group">Add an idea</button> to start
          tracking who's up for what.</p>
      </div>`;
  } else {
    html += `<h3 class="sectionhead">${esc(chosen.activity.title)}</h3>`;
  }

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
  const implicit = !p.activities.length;
  const board = implicit ? [] : compareActivities(p);
  const chosen = implicit
    ? { activity: { title: p.title, id: null }, view: activityView(p, null),
        activeCount: activeParticipants(activityView(p, null)).length }
    : (board.find(b => b.activity.id === state.activityId) || board[0]);
  const silent = silentParticipants(p);
  let html = '';

  html += draft('d-invite', 'Invite people',
    'The opener. The link does the asking, so you never collect answers by text again.',
    `Trying to sort out ${p.title} — ${fmtRange(p.window.start, p.window.end)}.\n\n` +
    `Tap here, put in when you can go, and say what you're up for:\n${shareURL()}\n\n` +
    `Takes a minute. No signup, and you can change it later.`);

  if (implicit) {
    // Nagging people to "reply with at least a maybe" when there is nothing to
    // reply to was the old behaviour. Ask the question that actually applies.
    html += draft('d-idea', 'Nobody has suggested anything yet',
      `You have availability from ${p.participants.length} ${p.participants.length === 1 ? 'person' : 'people'} but no idea on the table, so there's nothing for anyone to be in or out of.`,
      `We've got everyone's dates for ${p.title} — now what are we actually doing?\n\n` +
      `Throw an idea in here and everyone can say if they're up for it:\n${shareURL()}`);
  }

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
    const what = implicit ? p.title : chosen.activity.title;

    if (full.length) {
      html += draft('d-lock', 'Lock in a date',
        `These clear every constraint on record${implicit ? '' : ` for ${chosen.activity.title}`}.`,
        `Good news — ${full.slice(0, 3).map(s => fmtShort(s.date)).join(', ')} work for everyone ` +
        `for ${what}.\n\nI'm leaning ${fmtLong(full[0].date)}. Any objection before I book it?`);
    } else if (ranked.length) {
      const picks = ranked.slice(0, 3);
      html += draft('d-narrow', 'Narrow it down',
        'Nothing catches everyone, so offer the best few and name the sticking point.',
        `No single date works for all of us on ${what}. Closest three:\n\n` +
        picks.map(s => `• ${fmtLong(s.date)} — ${s.in.map(name).join(', ')}`).join('\n') +
        `\n\nCan anyone stretch? Otherwise I'll go with ${fmtLong(picks[0].date)}.`);
    }

    // The unlock nudge — the ask that actually changes the answer.
    for (const o of unlockOpportunities(view).slice(0, 2)) {
      const who = o.conditions.map(c => name(c.id)).join(' & ');
      html += draft(`d-unlock-${o.dates[0]}`, `Solve it for ${who}`,
        `${o.dates.length} date${o.dates.length === 1 ? '' : 's'} go to full turnout if this gets sorted.`,
        `We're one thing away from all of us making ${what} on ` +
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
    const better = implicit ? null
      : board.find(b => b.activity.id !== chosen.activity.id && b.reach > chosen.reach);
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

/**
 * Toggle one day. A day covered by a saved range is the awkward case: the range
 * is a single object, so freeing one day means expanding it into the individual
 * days it stood for, minus the one tapped. The chip disappears and the rest stay
 * blocked, which is what someone tapping a day expects.
 */
function toggleDay(me, ymd) {
  if (state.calMode === 'only') {
    const has = (me.onlyDates || []).includes(ymd);
    patchMe({
      onlyDates: has ? me.onlyDates.filter(d => d !== ymd)
                     : [...new Set([...(me.onlyDates || []), ymd])].sort(),
    }, { immediate: true });
    return;
  }
  const range = rangeCovering(me, ymd);
  if (range) {
    const expanded = eachDay(range.start, range.end).filter(d => d !== ymd);
    patchMe({
      blackouts: [...new Set([...(me.blackouts || []), ...expanded])].sort(),
      blackoutRanges: (me.blackoutRanges || []).filter(r => r !== range),
    }, { immediate: true });
    return;
  }
  const has = (me.blackouts || []).includes(ymd);
  patchMe({
    blackouts: has ? me.blackouts.filter(d => d !== ymd)
                   : [...new Set([...(me.blackouts || []), ymd])].sort(),
  }, { immediate: true });
}

/**
 * Drag-paint, mouse only. On touch a drag is a scroll, and hijacking it to
 * select dates makes the page feel broken — a tap there goes through the normal
 * click handler instead.
 *
 * A sweep paints the DOM directly and commits once on release. Re-rendering per
 * day would tear out the cells mid-drag and the sweep would lose the pointer.
 */
let paint = null;
let suppressClick = false;

/**
 * Preview the sweep. Painting only the cells that fired pointerover loses days
 * on a fast drag — the pointer never lands on them. So the span between where
 * the drag started and where it is now gets painted whole, which also makes
 * dragging back over yourself undo cleanly.
 */
function paintPreview() {
  const { originDate, current, cells, snapshot, mode } = paint;
  const lo = originDate <= current ? originDate : current;
  const hi = originDate <= current ? current : originDate;
  for (const el of cells) {
    const d = el.dataset.date;
    if (d >= lo && d <= hi) {
      el.className = mode === 'block' ? 'cal-day is-blocked' : 'cal-day';
      el.setAttribute('aria-pressed', String(mode === 'block'));
    } else {
      el.className = snapshot.get(d).cls;
      el.setAttribute('aria-pressed', snapshot.get(d).pressed);
    }
  }
}

document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  const cell = e.target.closest('[data-act="cal-day"]');
  if (!cell || !meRow()) return;
  const cells = [...document.querySelectorAll('[data-act="cal-day"]')];
  paint = {
    // Whatever the first cell would become, the whole sweep follows.
    mode: cell.getAttribute('aria-pressed') === 'true' ? 'free' : 'block',   // 'block' also means "add" in only-mode
    originDate: cell.dataset.date,
    current: cell.dataset.date,
    cells,
    snapshot: new Map(cells.map(el =>
      [el.dataset.date, { cls: el.className, pressed: el.getAttribute('aria-pressed') }])),
    dragged: false,
  };
});

document.addEventListener('pointerover', e => {
  if (!paint) return;
  const cell = e.target.closest('[data-act="cal-day"]');
  if (!cell || cell.dataset.date === paint.current) return;
  paint.dragged = true;
  paint.current = cell.dataset.date;
  paintPreview();
});

document.addEventListener('pointerup', () => {
  const p = paint;
  paint = null;
  if (!p || !p.dragged) return;      // a plain click — the click handler has it
  suppressClick = true;              // ...but a drag must not also fire one
  setTimeout(() => { suppressClick = false; }, 0);

  const me = meRow();
  if (!me) return;
  const lo = p.originDate <= p.current ? p.originDate : p.current;
  const hi = p.originDate <= p.current ? p.current : p.originDate;
  const span = eachDay(lo, hi);

  if (state.calMode === 'only') {
    const list = new Set(me.onlyDates || []);
    for (const d of span) { if (p.mode === 'block') list.add(d); else list.delete(d); }
    patchMe({ onlyDates: [...list].sort() }, { immediate: true });
    return;
  }

  let ranges = [...(me.blackoutRanges || [])];
  const blackouts = new Set(me.blackouts || []);
  // Any saved range the sweep touched becomes individual days, so days inside
  // it can be freed one at a time.
  for (const r of [...ranges]) {
    if (span.some(d => daysBetween(r.start, d) >= 0 && daysBetween(d, r.end) >= 0)) {
      eachDay(r.start, r.end).forEach(d => blackouts.add(d));
      ranges = ranges.filter(x => x !== r);
    }
  }
  for (const d of span) {
    if (p.mode === 'block') blackouts.add(d); else blackouts.delete(d);
  }
  patchMe({ blackouts: [...blackouts].sort(), blackoutRanges: ranges }, { immediate: true });
});

document.addEventListener('pointercancel', () => { paint = null; });

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

  // Weekday picker — the one inside an offer editor scopes that offer, not you.
  if (btn.dataset.wd !== undefined && btn.closest('[data-act="unlock-days"]')) {
    const wd = Number(btn.dataset.wd);
    const field = btn.closest('[data-act="edit-unlock-form"]')?.elements.condition;
    if (field) state.editingUnlockText = field.value;
    const cur = new Set(state.editingUnlockDays || []);
    cur.has(wd) ? cur.delete(wd) : cur.add(wd);
    state.editingUnlockDays = [...cur].sort((a, b) => a - b);
    render();
    return;
  }
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

    case 'rename-start': state.renaming = true; render(); break;
    case 'rename-cancel': state.renaming = false; render(); break;
    case 'rename-save':
      await guard(async () => {
        const name = $('#rename-input').value.trim();
        if (!name || name === me.name) { state.renaming = false; render(); return; }
        await api.updateParticipant(state.slug, state.me.token, { name });
        state.me.name = name;
        api.rememberIdentity(state.slug, { ...state.me, title: state.plan.title });
        state.renaming = false;
        await refresh();
        toast(`You're now ${name}.`);
      });
      break;

    case 'copy-personal':
      copyText(personalURL(), () => toast('Private link copied — it signs you in as you.'));
      break;

    case 'not-me':
      // Releasing matters: a forgotten token would lock this row for everyone,
      // including whoever it actually belongs to.
      if (!confirm(`Give up the "${me.name}" spot? Their answers stay on the plan, and `
                 + `whoever it really is can claim it.`)) break;
      await guard(async () => {
        try { await api.releaseParticipant(state.slug, state.me.token); }
        catch (err) { console.warn('Could not release the spot:', err); }
        api.forgetIdentity(state.slug);
        state.me = null;
        await refresh();
      });
      break;

    case 'interest':
      await guard(async () => {
        const level = me.interests?.[btn.dataset.activity]?.level === btn.dataset.status
          ? 'pending' : btn.dataset.status;
        me.interests = { ...(me.interests || {}), [btn.dataset.activity]: { level, note: '' } };
        // Save first, prompt second: stepping back is always allowed.
        state.optOut = (level === 'no' || level === 'maybe')
          ? { activityId: btn.dataset.activity, level } : null;
        render();
        await api.setInterest(state.slug, state.me.token, btn.dataset.activity, level, null);
        await refresh({ quiet: true });
      });
      break;

    case 'nudge-dismiss': state.optOut = null; render(); break;
    case 'nudge-offer':
      state.optOut = null;
      render();
      setTimeout(() => {
        const el = $('[data-act="unlock-text"]');
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.focus();
      }, 60);
      break;
    case 'nudge-dates':
      state.optOut = null;
      render();
      setTimeout(() => {
        const el = $('[data-act="weekdays"]');
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 60);
      break;

    case 'cal-day':
      if (!suppressClick) toggleDay(me, btn.dataset.date);
      break;

    case 'clear-blackouts':
      if (!confirm('Clear every blocked day?')) break;
      patchMe({ blackouts: [], blackoutRanges: [] }, { immediate: true });
      break;
    case 'rm-range':
      patchMe({ blackoutRanges: me.blackoutRanges.filter((_, i) => i !== Number(btn.dataset.val)) }, { immediate: true }); break;
    case 'cal-mode': state.calMode = btn.dataset.mode; render(); break;
    case 'clear-only':
      if (!confirm('Clear the short list, so every day is back in play?')) break;
      patchMe({ onlyDates: [] }, { immediate: true });
      break;
    case 'rm-unlock':
      patchMe({ unlocks: (me.unlocks || []).filter(u => u.id !== btn.dataset.val) }, { immediate: true }); break;

    case 'edit-unlock': {
      const u = (me.unlocks || []).find(x => x.id === btn.dataset.val);
      state.editingUnlock = btn.dataset.val;
      state.editingUnlockDays = [...(u?.weekdays || [])];
      state.editingUnlockText = u?.condition ?? '';
      render();
      break;
    }
    case 'unlock-cancel':
      state.editingUnlock = null; state.editingUnlockDays = null;
      state.editingUnlockText = null; render(); break;

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
        await api.updateWindow(state.slug, state.me.token, $('#p-start').value, $('#p-end').value);
        await refresh();
        toast('Window updated');
      });
      break;

    case 'edit-activity': state.editingActivity = btn.dataset.val; render(); break;
    case 'edit-cancel': state.editingActivity = null; render(); break;

    case 'toggle-date':
      state.openDates.has(btn.dataset.date) ? state.openDates.delete(btn.dataset.date)
                                            : state.openDates.add(btn.dataset.date);
      renderWhen();
      break;

    case 'go-group': state.tab = 'group'; render(); break;

    case 'copy-invite': copyText(state.invite.url, () => toast('Link copied.')); break;
    case 'copy-invite-text':
      copyText(inviteMessage(state.invite.name, state.invite.url), () => toast('Message copied.'));
      break;
    case 'clear-invite': state.invite = null; render(); break;
    case 'copy-invite-for': {
      const url = inviteURL(btn.dataset.val);
      copyText(inviteMessage(btn.dataset.val, url), () => toast(`Invite for ${btn.dataset.val} copied.`));
      break;
    }
    case 'remove-participant':
      if (!confirm(`Withdraw the invite for ${btn.dataset.name}? Anything entered on `
                 + `their behalf goes with it.`)) break;
      await guard(async () => {
        await api.removeParticipant(state.slug, state.me.token, btn.dataset.val);
        await refresh();
        toast(`${btn.dataset.name} removed.`);
      });
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
    const idea = $('#c-activity').value.trim();
    const res = await api.createPlan({
      title: idea, start: $('#c-start').value, end: $('#c-end').value,
      activity: idea, name: $('#c-name').value.trim(),
    });
    state.slug = res.slug;
    state.me = { participantId: res.participantId, token: res.token, name: $('#c-name').value.trim() };
    api.rememberIdentity(res.slug, { ...state.me, title: idea });
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
  if (e.target.dataset.act === 'invite-form') {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    if (!name) return;
    await guard(async () => {
      const res = await api.inviteParticipant(state.slug, state.me.token, name);
      if (res.joined) { toast(`${name} has already joined.`, true); return; }
      e.target.elements.name.value = '';
      state.invite = { name: res.name || name, url: inviteURL(res.name || name) };
      await refresh();
    });
    return;
  }
  if (e.target.dataset.act === 'edit-unlock-form') {
    e.preventDefault();
    const me2 = meRow();
    const id = e.target.dataset.val;
    const condition = e.target.elements.condition.value.trim();
    if (!condition) { toast('An offer needs a condition.', true); return; }
    const next = (me2.unlocks || []).map(u => u.id === id
      ? { ...u, condition, weekdays: state.editingUnlockDays || [] } : u);
    state.editingUnlock = null; state.editingUnlockDays = null; state.editingUnlockText = null;
    patchMe({ unlocks: next }, { immediate: true });
    return;
  }
  if (e.target.dataset.act === 'edit-activity-form') {
    e.preventDefault();
    await guard(async () => {
      await api.updateActivity(state.slug, state.me.token, e.target.dataset.val,
        e.target.elements.title.value.trim(), e.target.elements.detail.value.trim());
      state.editingActivity = null;
      await refresh();
      toast('Updated.');
    });
    return;
  }
  if (e.target.dataset.act === 'add-activity-form') {
    e.preventDefault();
    const title = e.target.elements.title?.value.trim();
    const detail = e.target.elements.detail?.value.trim() || '';
    if (!title) return;
    await guard(async () => {
      const first = !state.plan.activities.length;
      await api.addActivity(state.slug, state.me.token, title, detail);
      await refresh();
      toast(first ? 'Up there — everyone can now say if they\'re in.'
                  : 'Added — it will be scored against the others.');
    });
  }
});

/* ---------------------------------------------------------------- share --- */

function inviteMessage(name, url) {
  return `${name} — we're trying to sort out ${state.plan.title}`
       + ` (${fmtRange(state.plan.window.start, state.plan.window.end)}).`
       + ` Tap here and put in when you could go — no signup, takes a minute:\n${url}`;
}

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
  const params = new URLSearchParams(location.search);
  const slug = params.get('p');
  if (!slug) { renderLanding(); return; }
  state.slug = slug;
  state.me = api.identity(slug);
  $('#loading').hidden = false;

  // A personal link carries a claim token. Verify it before trusting it, then
  // strip it from the address bar so it stops riding along in history and
  // screenshots.
  state.invitedAs = params.get('for');
  if (state.invitedAs) history.replaceState({}, '', `?p=${encodeURIComponent(slug)}`);

  const token = params.get('me');
  if (token) {
    history.replaceState({}, '', `?p=${encodeURIComponent(slug)}`);
    try {
      const who = await api.whoami(slug, token);
      if (who) {
        state.me = { participantId: who.participantId, token, name: who.name };
        api.rememberIdentity(slug, { ...state.me });
        setTimeout(() => toast(`Signed in as ${who.name}.`), 300);
      } else {
        setTimeout(() => toast('That personal link is no longer valid.', true), 300);
      }
    } catch (e) {
      console.warn('Could not verify that personal link:', e);
    }
  }

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

/* =========================================================================
 * Reading a group text thread
 *
 * People answer by text whether or not you send them a link, so the app has
 * to meet that reality. Paste the thread (or a screenshot of it) and it gets
 * split by speaker, matched against the roster, and run through the same
 * constraint parser — with a review step in between, because attribution from
 * a screenshot is a guess and filing someone's constraints under the wrong
 * name is worse than filing none.
 *
 * Everything happens in this browser. The messages are never uploaded.
 * ========================================================================= */


const IGNORE = '__ignore__';

function openThread() {
  state.thread = { step: 'input', messages: [], text: '', busy: false,
                   picks: {}, patches: {}, interests: {}, targetActivity: state.activityId };
  renderThread();
  $('#thread-dialog').showModal();
}

function threadRoster() { return state.plan.participants; }

function renderThread() {
  const t = state.thread;
  if (!t) return;
  const box = $('#thread-body');

  if (t.step === 'input') {
    box.innerHTML = `
      <h2>Read a thread</h2>
      <p class="hint">Paste the conversation, or drop in a screenshot of it. Nothing
        is uploaded — the reading happens on this device.</p>
      <div class="field" style="margin-top:.6rem">
        <textarea id="thread-text" style="min-height:9rem"
          placeholder="Sara: yes but only Saturdays work here&#10;Dev: maybe — my partner can only do Mon/Wed&#10;Ana: in! just need two weeks notice"></textarea>
      </div>
      <div class="inline-add">
        <button class="btn btn-primary btn-sm" data-act="thread-read">Read it</button>
        <label class="btn btn-sm" for="thread-image">Use a screenshot</label>
        <input id="thread-image" type="file" accept="image/*" hidden>
      </div>
      <div id="thread-progress" class="hint" style="margin-top:.5rem"></div>`;
    return;
  }

  if (t.step === 'review') {
    const roster = threadRoster();
    const opts = (sel) => `
      <option value="${IGNORE}" ${!sel ? 'selected' : ''}>— skip this line —</option>
      ${roster.map(p => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}${p.claimed ? '' : ' (not joined)'}</option>`).join('')}
      ${[...new Set(t.messages.map(m => m.speaker).filter(Boolean))]
        .filter(n => !roster.some(p => p.name.toLowerCase() === n.toLowerCase()))
        .map(n => `<option value="new:${esc(n)}" ${sel === 'new:' + n ? 'selected' : ''}>＋ add ${esc(n)}</option>`).join('')}`;

    box.innerHTML = `
      <h2>Who said what?</h2>
      <p class="hint">${t.messages.length} message${t.messages.length === 1 ? '' : 's'} found.
        Fix anything it got wrong — nothing is applied yet.</p>
      <div class="reviewlist">
        ${t.messages.map((m, i) => `
          <div class="reviewrow">
            <select data-act="thread-pick" data-idx="${i}">${opts(t.picks[i])}</select>
            <p>${esc(m.text)}</p>
          </div>`).join('')}
      </div>
      <div class="inline-add" style="margin-top:.7rem">
        <button class="btn btn-primary btn-sm" data-act="thread-extract">Pull out the constraints</button>
        <button class="btn btn-sm btn-ghost" data-act="thread-back">Back</button>
      </div>`;
    return;
  }

  if (t.step === 'apply') {
    const roster = threadRoster();
    const nameOfPick = pick => pick.startsWith('new:') ? pick.slice(4)
      : (roster.find(p => p.id === pick)?.name || '');

    const people = Object.entries(t.people).map(([pick, info]) => {
      const name = nameOfPick(pick);
      const existing = roster.find(p => p.name.toLowerCase() === name.toLowerCase());
      const locked = existing && existing.claimed && existing.id !== state.me.participantId;
      const chips = info.suggestions;
      const applied = t.patches[pick] || {};
      const appliedCount = Object.keys(applied).length + (t.interests[pick] ? 1 : 0);

      return `
        <div class="card">
          <div class="person-head">
            <b style="flex:1">${esc(name)}</b>
            ${locked ? '<span class="pill">has joined</span>'
                     : appliedCount ? `<span class="pill good">${appliedCount} to save</span>` : ''}
          </div>
          <p class="quote">“${esc(info.text)}”</p>
          ${locked ? `<p class="hint">${esc(name)} is answering for themselves, so this
              won't overwrite them. Nudge them on the Ask tab instead.</p>`
            : chips.length || info.status ? `
            <div class="sugg-list" style="margin-top:.5rem">
              ${info.status ? `<button class="sugg" data-act="thread-status" data-pick="${esc(pick)}"
                  data-status="${info.status}">Mark ${esc(info.status)}<small>for ${esc(activityTitle(t.targetActivity))}</small></button>` : ''}
              ${chips.map((c, i) => `<button class="sugg" data-act="thread-apply"
                  data-pick="${esc(pick)}" data-idx="${i}">${esc(c.label)}<small>${esc(c.detail)}</small></button>`).join('')}
            </div>` : '<p class="hint">Nothing recognisable in that.</p>'}
        </div>`;
    }).join('');

    box.innerHTML = `
      <h2>What it found</h2>
      <p class="hint">Tap what's right. Same rule as everywhere else — nothing is
        applied until you say so.</p>
      ${state.plan.activities.length > 1 ? `
        <div class="field" style="margin-top:.5rem">
          <span>Read "yes / maybe / no" as interest in</span>
          <select data-act="thread-target">
            ${state.plan.activities.map(a => `<option value="${a.id}"
              ${a.id === t.targetActivity ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}
          </select>
        </div>` : ''}
      ${people || '<div class="card empty">Nobody was attributed.</div>'}
      <div class="inline-add" style="margin-top:.7rem">
        <button class="btn btn-primary" data-act="thread-save" ${t.busy ? 'disabled' : ''}>
          ${t.busy ? 'Saving…' : 'Save to the plan'}</button>
        <button class="btn btn-sm btn-ghost" data-act="thread-back-review">Back</button>
      </div>`;
  }
}

function activityTitle(id) {
  return state.plan.activities.find(a => a.id === id)?.title || 'this plan';
}

/** Review step: seed each message's speaker from what the splitter guessed. */
function toReview(raw) {
  const t = state.thread;
  const roster = threadRoster();
  const res = splitThread(raw, roster);
  if (!res.messages.length) { toast('No messages found in that.', true); return; }

  t.text = raw;
  t.messages = res.messages;
  t.picks = {};
  res.messages.forEach((m, i) => {
    if (m.participantId) t.picks[i] = m.participantId;
    else if (m.speaker) t.picks[i] = 'new:' + m.speaker;
  });
  t.step = 'review';
  renderThread();
}

/** Review → per-person constraint suggestions. */
function toApply() {
  const t = state.thread;
  const byPick = {};
  t.messages.forEach((m, i) => {
    const pick = t.picks[i];
    if (!pick || pick === IGNORE) return;
    (byPick[pick] = byPick[pick] || []).push(m.text);
  });

  t.people = {};
  for (const [pick, texts] of Object.entries(byPick)) {
    const text = texts.join('. ').replace(/\.\s*\./g, '.');
    const parsed = parseReply(text, state.plan.window);
    t.people[pick] = { text, suggestions: parsed.suggestions, status: parsed.status };
  }
  t.patches = {};
  t.interests = {};
  t.step = 'apply';
  renderThread();
}

async function saveThread() {
  const t = state.thread;
  const roster = threadRoster();
  t.busy = true; renderThread();

  const nameOfPick = pick => pick.startsWith('new:') ? pick.slice(4)
    : (roster.find(p => p.id === pick)?.name || '');

  let saved = 0, skipped = [];
  const picks = new Set([...Object.keys(t.patches), ...Object.keys(t.interests)]);

  for (const pick of picks) {
    const name = nameOfPick(pick);
    if (!name) continue;
    const interests = t.interests[pick] ? { [t.targetActivity]: t.interests[pick] } : {};
    try {
      await api.fillInFor(state.slug, state.me.token, name, t.patches[pick] || {}, interests);
      saved++;
    } catch (e) {
      skipped.push(`${name} (${e.message})`);
    }
  }

  t.busy = false;
  $('#thread-dialog').close();
  state.thread = null;
  await refresh();
  if (saved) toast(`Saved ${saved} ${saved === 1 ? 'person' : 'people'} from the thread.`);
  if (skipped.length) toast('Skipped: ' + skipped.join('; '), true);
}

/* --- thread events -------------------------------------------------------- */

document.addEventListener('click', async e => {
  const btn = e.target.closest('button, label');
  if (!btn) return;
  const t = state.thread;

  switch (btn.dataset.act) {
    case 'open-thread': openThread(); break;
    case 'thread-read': toReview($('#thread-text').value); break;
    case 'thread-back': t.step = 'input'; renderThread(); break;
    case 'thread-back-review': t.step = 'review'; renderThread(); break;
    case 'thread-extract': toApply(); break;

    case 'thread-apply': {
      const pick = btn.dataset.pick;
      const info = t.people[pick];
      const s = info.suggestions.splice(Number(btn.dataset.idx), 1)[0];
      const base = t.patches[pick] || {};
      const merged = { ...base };
      for (const [k, v] of Object.entries(s.patch)) {
        if (k === 'blackouts' || k === 'onlyDates') merged[k] = [...new Set([...(base[k] || []), ...v])].sort();
        else if (k === 'blackoutRanges' || k === 'unlocks') merged[k] = [...(base[k] || []), ...v];
        else merged[k] = v;
      }
      t.patches[pick] = merged;
      renderThread();
      break;
    }
    case 'thread-status': {
      t.interests[btn.dataset.pick] = btn.dataset.status;
      t.people[btn.dataset.pick].status = null;
      renderThread();
      break;
    }
    case 'thread-save': await saveThread(); break;
  }
});

document.addEventListener('change', async e => {
  const t = state.thread;
  if (!t) return;
  if (e.target.dataset.act === 'thread-pick') {
    t.picks[Number(e.target.dataset.idx)] = e.target.value;
  }
  if (e.target.dataset.act === 'thread-target') {
    t.targetActivity = e.target.value;
  }
  if (e.target.id === 'thread-image') {
    const file = e.target.files[0];
    if (!file) return;
    const prog = $('#thread-progress');
    prog.textContent = 'Loading the OCR engine (a few MB, first time only)…';
    try {
      const { imageToLines, linesToTranscript } = await import('./ocr.js');
      const { lines } = await imageToLines(file, (pct, label) => {
        prog.textContent = `${label}… ${pct}%`;
      });
      if (!lines.length) { prog.textContent = 'No text found in that image.'; return; }
      const meName = meRow()?.name || 'Me';
      const transcript = linesToTranscript(lines, threadRoster(), meName);
      prog.textContent = '';
      toReview(transcript);
    } catch (err) {
      prog.textContent = '';
      toast(err.message || 'Could not read that image', true);
    } finally {
      e.target.value = '';
    }
  }
});

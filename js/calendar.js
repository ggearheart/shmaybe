// A month grid for picking the days you can't do.
//
// Replaces a date input you had to operate once per day. Tapping toggles, and
// on a mouse you can drag across a stretch. Touch deliberately doesn't paint:
// a drag on a phone is a scroll, and stealing that to select dates makes the
// page feel broken.

import { monthsOf, weekdayOf, daysBetween, todayYMD, WEEKDAY_MIN } from './dates.js';

/** Is this date inside one of the participant's saved ranges? */
export function rangeCovering(me, ymd) {
  return (me.blackoutRanges || []).find(r =>
    daysBetween(r.start, ymd) >= 0 && daysBetween(ymd, r.end) >= 0) || null;
}

/**
 * @param mode 'block' — tapping marks days you can't do (the common case)
 *             'only'  — tapping marks the only days you *can*, for when
 *                       somebody's options really are that narrow
 */
export function renderCalendar(me, plan, mode = 'block', asOf = todayYMD()) {
  const months = monthsOf(plan.window.start, plan.window.end);
  const allowed = me.weekdays && me.weekdays.length ? me.weekdays : null;
  const blocked = new Set(me.blackouts || []);
  const only = new Set(me.onlyDates || []);

  const cell = ymd => {
    const outside = daysBetween(plan.window.start, ymd) < 0 || daysBetween(ymd, plan.window.end) < 0;
    const past = daysBetween(asOf, ymd) < 0;
    if (outside || past) {
      return `<span class="cal-day is-out" aria-hidden="true">${Number(ymd.slice(8))}</span>`;
    }
    const inRange = !!rangeCovering(me, ymd);
    const isBlocked = blocked.has(ymd);
    const dimmed = allowed && !allowed.includes(weekdayOf(ymd));
    const classes = ['cal-day',
      isBlocked ? 'is-blocked' : '',
      inRange ? 'in-range' : '',
      dimmed ? 'is-dim' : '',
      only.has(ymd) ? 'is-only' : ''].filter(Boolean).join(' ');
    const on = mode === 'only' ? only.has(ymd) : (isBlocked || inRange);
    const label = only.has(ymd) ? 'one of the only days that work'
                : isBlocked || inRange ? 'blocked'
                : dimmed ? 'weekday does not work' : 'available';
    return `<button type="button" class="${classes}" data-act="cal-day" data-date="${ymd}"
              aria-pressed="${on}" title="${ymd} — ${label}">${Number(ymd.slice(8))}</button>`;
  };

  const count = blocked.size + (me.blackoutRanges || []).reduce(
    (n, r) => n + Math.max(0, daysBetween(r.start, r.end) + 1), 0);

  const onlyCount = (me.onlyDates || []).length;
  return `
    <div class="statusgroup calmode">
      <button type="button" data-act="cal-mode" data-mode="block" aria-pressed="${mode === 'block'}">
        Days I can't do</button>
      <button type="button" data-act="cal-mode" data-mode="only" aria-pressed="${mode === 'only'}">
        Only these days</button>
    </div>
    <p class="hint">${mode === 'block'
      ? 'Tap any days that are out — as many as you like. On a computer you can drag across a stretch.'
      : 'Only use this if your options really are that narrow: it rules out every other day.'}</p>
    <div class="cal" data-act="cal">
      ${months.map(m => `
        <div class="cal-month">
          <h4>${m.label}</h4>
          <div class="cal-grid">
            ${WEEKDAY_MIN.map(d => `<span class="cal-dow">${d[0]}</span>`).join('')}
            ${'<span class="cal-pad"></span>'.repeat(m.lead)}
            ${m.days.map(cell).join('')}
          </div>
        </div>`).join('')}
    </div>
    <div class="cal-legend">
      <span><i class="sw blocked"></i> can't do</span>
      ${onlyCount ? '<span><i class="sw only"></i> only these work</span>' : ''}
      <span><i class="sw dim"></i> weekday you ruled out</span>
      ${mode === 'block' && count ? `<button class="linkbtn" data-act="clear-blackouts">Clear all ${count}</button>` : ''}
      ${mode === 'only' && onlyCount ? `<button class="linkbtn" data-act="clear-only">Clear the ${onlyCount}-day list</button>` : ''}
    </div>`;
}

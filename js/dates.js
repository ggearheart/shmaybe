// Date helpers. Everything is a local-time "YYYY-MM-DD" string so we never
// touch UTC and never lose a day to a timezone boundary.

export const WEEKDAY_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export const WEEKDAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export const WEEKDAY_MIN = ['Su','M','Tu','W','Th','F','Sa'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromYMD(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayYMD() {
  return toYMD(new Date());
}

export function weekdayOf(ymd) {
  return fromYMD(ymd).getDay();
}

export function addDays(ymd, n) {
  const d = fromYMD(ymd);
  d.setDate(d.getDate() + n);
  return toYMD(d);
}

export function daysBetween(a, b) {
  return Math.round((fromYMD(b) - fromYMD(a)) / 86400000);
}

/** Inclusive list of every date from start to end. */
export function eachDay(start, end) {
  const out = [];
  if (!start || !end || daysBetween(start, end) < 0) return out;
  let cur = start;
  // Hard stop so a fat-fingered year can't hang the page.
  for (let i = 0; i <= 1000 && daysBetween(cur, end) >= 0; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** The Sunday-through-Saturday week containing `ymd`. */
export function weekOf(ymd) {
  const start = addDays(ymd, -weekdayOf(ymd));
  return { start, end: addDays(start, 6) };
}

export function fmtShort(ymd) {
  const d = fromYMD(ymd);
  return `${WEEKDAY_SHORT[d.getDay()]} ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

export function fmtLong(ymd) {
  const d = fromYMD(ymd);
  return `${WEEKDAY_LONG[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

export function fmtRange(a, b) {
  return a === b ? fmtShort(a) : `${fmtShort(a)} – ${fmtShort(b)}`;
}

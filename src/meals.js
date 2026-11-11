// Fixed meal times (e.g. a cat fed at 08:00, 13:00, 19:00 in the configured TZ).
// A "slot" is one meal time on one local date, keyed like "2026-11-11T19:00".
// Each slot gets exactly one bounty, posted at a random moment within ±15 min of the meal time.
// Pure functions only, no DB or Telegram here.

export const MEAL_JITTER_MS = 15 * 60_000;
// A slot stays eligible a little past +15 min so a fire time at the very edge
// isn't skipped just because the scheduler only ticks once a minute.
const SLOT_GRACE_MS = 2 * 60_000;
const MAX_MEALS = 8;

const pad = (n) => String(n).padStart(2, '0');

/** Turn AI or user input like ["8am", "13:00", "7.30 pm"] into sorted, unique "HH:MM" strings. */
export function normalizeMealTimes(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const raw of list) {
    const m = String(raw).trim().toLowerCase().replace(/\./g, ':').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) continue;
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (m[3]) {
      if (h < 1 || h > 12) continue;
      h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
    }
    if (h > 23 || min > 59) continue;
    out.add(`${pad(h)}:${pad(min)}`);
  }
  return [...out].sort().slice(0, MAX_MEALS);
}

function zonedParts(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// How far ahead of UTC the zone is at this instant (handles DST).
function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - whole;
}

/** Epoch ms for a wall-clock time in a timezone. Day overflow (d = 32) rolls into the next month. */
export function zonedTimeToMs(y, mo, d, h, mi, tz) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const first = asUtc - offsetMs(asUtc, tz);
  return asUtc - offsetMs(first, tz);
}

/** Meal slots whose window hasn't closed and that haven't been posted yet, soonest first. */
export function upcomingSlots(mealTimes, now, tz, doneSlots = []) {
  const today = zonedParts(now, tz);
  const slots = [];
  for (let dayOffset = -1; dayOffset <= 2; dayOffset++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + dayOffset));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    for (const time of mealTimes) {
      const [h, mi] = time.split(':').map(Number);
      const nominalAt = zonedTimeToMs(y, mo, d, h, mi, tz);
      const key = `${y}-${pad(mo)}-${pad(d)}T${time}`;
      if (nominalAt + MEAL_JITTER_MS + SLOT_GRACE_MS > now && !doneSlots.includes(key)) slots.push({ key, time, nominalAt });
    }
  }
  return slots.sort((a, b) => a.nominalAt - b.nominalAt);
}

/**
 * The plan for the buddy's next meal: { key, time, nominalAt, fireAt }.
 * Reuses the stored plan while it still points at the next slot, so the random fire time is chosen once per slot.
 * Returns { plan, changed } or null if the buddy has no meal times.
 */
export function nextMealPlan(buddy, now, tz, rand = Math.random) {
  const times = buddy.mealTimes || [];
  if (!times.length) return null;
  const next = upcomingSlots(times, now, tz, buddy.mealSlotsDone || [])[0];
  if (!next) return null;
  const stored = buddy.mealPlan;
  if (stored && stored.key === next.key && stored.nominalAt === next.nominalAt) return { plan: stored, changed: false };
  const jitter = Math.round((rand() * 2 - 1) * MEAL_JITTER_MS);
  // If we're already inside the window (e.g. bot just started), never schedule in the past.
  const fireAt = Math.max(now, next.nominalAt + jitter);
  return { plan: { ...next, fireAt }, changed: true };
}

/** Record a slot as used so it can never be posted again. Keeps a short history. */
export function markSlotDone(buddy, key) {
  const done = buddy.mealSlotsDone || [];
  if (!done.includes(key)) buddy.mealSlotsDone = [...done, key].slice(-30);
  if (buddy.mealPlan?.key === key) delete buddy.mealPlan;
}

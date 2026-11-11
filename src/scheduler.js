// Every minute: expire stale claims, raise rewards on ignored bounties, and let buddies post bounties at random times.
import { config } from './config.js';
import { db, openBountyFor } from './db.js';
import * as game from './game.js';

let running = false;

export async function tick() {
  if (running) return;
  running = true;
  try {
    await game.expireClaims();
    await game.surgeStaleBounties();
    for (const buddy of Object.values(db().buddies)) {
      if (buddy.paused || openBountyFor(buddy.id)) continue;
      if (!game.isAwake(buddy)) continue;
      if (game.cooldownLeftMs(buddy) > 0) continue;
      // Random timing: on average a buddy asks ~2 min (demo) or ~45 min (normal) after it becomes "needy".
      const chancePerMinute = config.demoMode ? 0.5 : 1 / 45;
      if (Math.random() > chancePerMinute) continue;
      await game.postBounty(buddy).catch((err) => console.error('[scheduler] postBounty failed:', err.message));
    }
  } catch (err) {
    console.error('[scheduler] tick error:', err);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setTimeout(tick, 5_000);
  return setInterval(tick, 60_000);
}

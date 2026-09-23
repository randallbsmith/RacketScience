import { resetGame } from './reset-game.js';
import { sendReminders } from './send-reminders.js';
import { pacificParts, pacificDate, weekday } from './dates.js';
if (process.env.SCHEDULES_ENABLED !== 'true') {
  console.log('Schedules are disabled. Set SCHEDULES_ENABLED=true only when ready.');
} else {
  async function tick() {
    const now = new Date(), p = pacificParts(now), day = weekday(pacificDate(now));
    try {
      if ([2, 5].includes(day) && +p.hour >= 15) await resetGame(now);
      if ([1, 4].includes(day) && +p.hour >= 1) await sendReminders({ now, send: true });
    } catch (error) { console.error(error.message); }
    setTimeout(tick, 60000);
  }
  tick();
}

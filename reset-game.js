import { transaction } from './store.js';
import { pacificDate, pacificParts, weekday, nextGame } from './dates.js';
import { pathToFileURL } from 'node:url';
export async function resetGame(now = new Date(), dir) {
  const today = pacificDate(now);
  if (![2, 5].includes(weekday(today)) || Number(pacificParts(now).hour) < 15) return { reset: false };
  return transaction(state => {
    const target = nextGame(today);
    if (state.gameDate >= target) return { reset: false };
    state.gameDate = target;
    for (const p of state.players) { p.attendance = null; p.comments = ''; }
    return { reset: true, gameDate: target };
  }, dir);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await resetGame());
}

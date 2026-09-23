export function pacificParts(now = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
}
export function pacificDate(now = new Date()) {
  const p = pacificParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}
export function weekday(date) { return new Date(`${date}T12:00:00Z`).getUTCDay(); }
export function nextGame(date, includeToday = false) {
  const d = new Date(`${date}T12:00:00Z`);
  if (!includeToday) d.setUTCDate(d.getUTCDate() + 1);
  while (![2, 5].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export function initialGame(now = new Date()) {
  const p = pacificParts(now), today = pacificDate(now);
  return nextGame(today, Number(p.hour) < 15 || ![2, 5].includes(weekday(today)));
}
export function dateLabel(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric'
  }).format(new Date(`${date}T12:00:00Z`));
}

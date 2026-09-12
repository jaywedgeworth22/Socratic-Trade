const fs = require('fs');
const content = fs.readFileSync('src/lib/market-hours.ts', 'utf8');

const replacement = `function localDateKey(date: Date): string {
  // Use ET rather than the server's local timezone (which is usually UTC in prod).
  // A late Friday evening in NY is early Saturday morning in UTC, which date.getDay()
  // would incorrectly flag as a weekend.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return \`\${getPart("year")}-\${getPart("month")}-\${getPart("day")}\`;
}

/** True when \`date\`'s ET calendar day is a US equity trading day: not a weekend, and not one
 *  of the fixed-calendar holidays from getMarketHolidays. */
export function isTradingDay(date: Date): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short"
  });
  const wd = formatter.format(date);
  if (wd === "Sun" || wd === "Sat") return false;
  
  // extract ET year
  const yearFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" });
  const year = parseInt(yearFormatter.format(date), 10);
  
  return !getMarketHolidays(year).has(localDateKey(date));
}

/** Walks from \`date\`'s ET calendar day, one day at a time in \`direction\` (+1 forward, -1
 *  backward), until it lands on a trading day. Bounded to 10 iterations — comfortably more than
 *  any real holiday cluster — so a bug here can never spin into an infinite loop. */
function adjacentTradingDayStart(date: Date, direction: 1 | -1): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // We use UTC Date to manipulate days safely without DST jumps affecting noon-anchored math.
  const d = new Date(Date.UTC(parseInt(getPart("year")), parseInt(getPart("month")) - 1, parseInt(getPart("day")), 12));
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() + direction);
    if (isTradingDay(d)) {
      // Return a Date object representing the start of that ET day.
      const etFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
      const [m, d2, y] = etFormatter.format(d).split("/");
      return new Date(\`\${y}-\${m}-\${d2}T00:00:00.000-05:00\`);
    }
  }
  return d;
}`;

// Replace the previous patch
let newContent = content.replace(/function localDateKey.*?return d;\n}/s, replacement);
fs.writeFileSync('src/lib/market-hours.ts', newContent);

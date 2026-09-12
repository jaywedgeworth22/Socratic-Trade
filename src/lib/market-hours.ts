// US market session detector using America/New_York wall-clock time.
// Regular session: Mon–Fri 09:30–16:00 ET.
// Extended: pre-market 04:00–09:30 ET, post-market 16:00–20:00 ET.
// Market holidays ARE modeled via getMarketHolidays() (see lines below).

export type MarketSession = "closed" | "regular" | "pre" | "post";

export function currentMarketSession(now = new Date()): MarketSession {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = parts.weekday; // "Mon", "Tue", ..., "Sat", "Sun"
  if (weekday === "Sat" || weekday === "Sun") return "closed";

  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const holidays = getMarketHolidays(parseInt(parts.year, 10));
  if (holidays.has(dateStr)) return "closed";

  // hour12: false gives "00"–"23"; pad handles "24" edge case Intl sometimes emits for midnight
  const hour = parseInt(parts.hour === "24" ? "0" : parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const totalMinutes = hour * 60 + minute;

  const PRE_OPEN = 4 * 60;       // 04:00
  const OPEN = 9 * 60 + 30;      // 09:30
  const closeEt = getMarketCloseEt({
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10)
  });
  const CLOSE = closeEt.hour * 60 + closeEt.minute;
  const POST_CLOSE = 20 * 60;    // 20:00

  if (totalMinutes >= OPEN && totalMinutes < CLOSE) return "regular";
  if (totalMinutes >= PRE_OPEN && totalMinutes < OPEN) return "pre";
  if (totalMinutes >= CLOSE && totalMinutes < POST_CLOSE) return "post";
  return "closed";
}

// Returns true if a strategy run is allowed right now given the policy preference.
export function isRunAllowedNow(runDuringExtendedHours: boolean, now = new Date()): boolean {
  const session = currentMarketSession(now);
  if (session === "regular") return true;
  if (runDuringExtendedHours && (session === "pre" || session === "post")) return true;
  return false;
}

// ── Trading-day calendar helpers ────────────────────────────────────────────
// These compare by the caller's LOCAL calendar day (not America/New_York wall-clock) — same
// convention already used by deriveDayPnl's "today" boundary (app/console/lib/derive.ts). US
// market holidays are NOT fixed dates (nth-weekday rules, Good Friday's computus, weekend
// observation shifts) — but getMarketHolidays resolves each year's set to concrete Y-M-D
// strings, so once resolved they compare as plain calendar days. A local calendar day can
// differ from the ET date near midnight for timezones far from ET; that's an accepted
// coarseness for these DISPLAY helpers (baseline-staleness flag, next-open hint) — anything
// needing exact session boundaries must use the ET session classifier above instead.

function localDateKey(date: Date): string {
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
  return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
}

/** True when `date`'s ET calendar day is a US equity trading day: not a weekend, and not one
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

/** Walks from `date`'s ET calendar day, one day at a time in `direction` (+1 forward, -1
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
      return new Date(`${y}-${m}-${d2}T00:00:00.000-05:00`);
    }
  }
  return d;
}

/** Local-midnight start of the most recent trading day strictly BEFORE `now`'s calendar date —
 *  i.e., the prior market session's date (yesterday's close, or last Friday's after a weekend).
 *  Used to detect a stale day-P&L baseline: if the last persisted snapshot predates this, there's
 *  a real gap, not just "yesterday". */
export function previousTradingDayStart(now: Date = new Date()): Date {
  return adjacentTradingDayStart(now, -1);
}

/** Local-midnight start of the next trading day strictly AFTER `now`'s calendar date. */
export function nextTradingDayStart(now: Date = new Date()): Date {
  return adjacentTradingDayStart(now, 1);
}

/** Cheap, best-effort "next open" hint for a paused (market-closed) run-state display. Deliberately
 *  coarse: it distinguishes "later today" (pre-market, still waiting for today's open) from "a
 *  future trading day" using the same ET session classifier as currentMarketSession, but does NOT
 *  special-case the narrow weekday 00:00–04:00 ET gap (it will say "next open" is the *following*
 *  day during those few hours, when the current calendar day would technically still qualify) —
 *  acceptable for a tooltip hint, not a scheduling primitive. */
export function nextMarketOpenHint(now: Date = new Date(), allowExtendedHours: boolean): string {
  const openClock = allowExtendedHours ? "4:00 AM ET (extended hours)" : "9:30 AM ET";
  if (currentMarketSession(now) === "pre") return `today, ${openClock}`;
  const next = nextTradingDayStart(now);
  const label = next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${label}, ${openClock}`;
}

export function getMarketHolidays(year: number): Set<string> {
  const holidays = new Set<string>();

  // 1. New Year's Day (observed)
  const ny = getObservedHoliday(year, 0, 1);
  holidays.add(ny.toISOString().split("T")[0]);
  
  // If Jan 1 of NEXT year is Saturday, Friday Dec 31 of this year is observed
  const nextYearNy = new Date(Date.UTC(year + 1, 0, 1));
  if (nextYearNy.getUTCDay() === 6) {
    holidays.add(`${year}-12-31`);
  }

  // 2. MLK Day: 3rd Monday in Jan
  holidays.add(getNthWeekdayOfMonth(year, 0, 1, 3).toISOString().split("T")[0]);

  // 3. Presidents' Day: 3rd Monday in Feb
  holidays.add(getNthWeekdayOfMonth(year, 1, 1, 3).toISOString().split("T")[0]);

  // 4. Good Friday
  holidays.add(getGoodFriday(year).toISOString().split("T")[0]);

  // 5. Memorial Day: Last Monday in May
  holidays.add(getLastWeekdayOfMonth(year, 4, 1).toISOString().split("T")[0]);

  // 6. Juneteenth (observed)
  holidays.add(getObservedHoliday(year, 5, 19).toISOString().split("T")[0]);

  // 7. Independence Day (observed)
  holidays.add(getObservedHoliday(year, 6, 4).toISOString().split("T")[0]);

  // 8. Labor Day: 1st Monday in Sep
  holidays.add(getNthWeekdayOfMonth(year, 8, 1, 1).toISOString().split("T")[0]);

  // 9. Thanksgiving: 4th Thursday in Nov
  holidays.add(getNthWeekdayOfMonth(year, 10, 4, 4).toISOString().split("T")[0]);

  // 10. Christmas Day (observed)
  holidays.add(getObservedHoliday(year, 11, 25).toISOString().split("T")[0]);

  return holidays;
}

export interface EarlyCloseTime {
  hour: number;
  minute: number;
}

/** US equity early-close days (1:00 PM ET) for a calendar year. */
export function getEarlyCloses(year: number): Map<string, EarlyCloseTime> {
  const closes = new Map<string, EarlyCloseTime>();
  const halfDay: EarlyCloseTime = { hour: 13, minute: 0 };
  const holidays = getMarketHolidays(year);

  const thanksgiving = getNthWeekdayOfMonth(year, 10, 4, 4);
  const dayAfterThanksgiving = new Date(thanksgiving);
  dayAfterThanksgiving.setUTCDate(dayAfterThanksgiving.getUTCDate() + 1);
  const dayAfterThanksgivingKey = dayAfterThanksgiving.toISOString().split("T")[0];
  if (!holidays.has(dayAfterThanksgivingKey)) {
    closes.set(dayAfterThanksgivingKey, halfDay);
  }

  const christmasEveKey = `${year}-12-24`;
  const christmasEveDow = new Date(Date.UTC(year, 11, 24)).getUTCDay();
  if (christmasEveDow >= 1 && christmasEveDow <= 5 && !holidays.has(christmasEveKey)) {
    closes.set(christmasEveKey, halfDay);
  }

  const july3Key = `${year}-07-03`;
  const july3Dow = new Date(Date.UTC(year, 6, 3)).getUTCDay();
  if (july3Dow >= 1 && july3Dow <= 5 && !holidays.has(july3Key)) {
    closes.set(july3Key, halfDay);
  }

  return closes;
}

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const date = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === weekday) {
      count++;
      if (count === n) {
        return date;
      }
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  throw new Error("Nth weekday not found");
}

function getLastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const date = new Date(Date.UTC(year, month + 1, 0));
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === weekday) {
      return date;
    }
    date.setUTCDate(date.getUTCDate() - 1);
  }
  throw new Error("Last weekday not found");
}

function getObservedHoliday(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month, day));
  const dow = date.getUTCDay();
  if (dow === 0) {
    date.setUTCDate(day + 1);
  } else if (dow === 6) {
    date.setUTCDate(day - 1);
  }
  return date;
}

// ── Weekend/holiday-aware cache-expiry helper ───────────────────────────────────────────────
// Distinct from previousTradingDayStart/nextTradingDayStart above: those intentionally compare
// by the CALLER's local calendar day (display-only staleness hints — see their doc comments).
// Cache TTL math needs exact ET session boundaries, so everything below works in
// America/New_York wall-clock time throughout, and — to build a UTC instant back out of an ET
// wall-clock time — uses the same DST-safe single offset-correction pass already established by
// millisUntilNextAlphaVantageDailyReset (src/lib/alpha-vantage-key-pool.ts): treat the target
// wall time as if it were UTC, read back what ET wall-clock that approximate instant actually
// represents via Intl.DateTimeFormat, then correct by the observed offset. This is exact except
// in the vanishingly rare case where the target time itself falls inside a spring-forward
// "skipped hour" gap, which 9:30 AM ET never does.

interface EtDateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

function etDateParts(date: Date): EtDateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: parseInt(parts.year, 10), month: parseInt(parts.month, 10), day: parseInt(parts.day, 10) };
}

/** Adds `days` to an ET calendar date. Pure calendar-day bookkeeping (UTC arithmetic on Y/M/D
 *  labels, not a timezone conversion) — mirrors adjacentTradingDayStart's day-stepping above. */
function addEtCalendarDays(parts: EtDateParts, days: number): EtDateParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** True when the given ET calendar date is a US equity trading day (weekday, not a holiday). */
function isEtCalendarTradingDay(parts: EtDateParts): boolean {
  const dow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const key = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return !getMarketHolidays(parts.year).has(key);
}

/** UTC epoch ms for `hour:minute:00` America/New_York wall clock on the given ET calendar date. */
function etWallClockToUtcMs(parts: EtDateParts, hour: number, minute: number): number {
  const approxUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(approxUtcMs)).map((x) => [x.type, x.value]));
  const approxAsUtcMs = Date.UTC(
    parseInt(p.year, 10),
    parseInt(p.month, 10) - 1,
    parseInt(p.day, 10),
    parseInt(p.hour === "24" ? "0" : p.hour, 10),
    parseInt(p.minute, 10),
    parseInt(p.second, 10)
  );
  const offsetMs = approxAsUtcMs - approxUtcMs;
  return approxUtcMs - offsetMs;
}

const MARKET_OPEN_HOUR_ET = 9;
const MARKET_OPEN_MINUTE_ET = 30;
const MARKET_CLOSE_HOUR_ET = 16;
const MARKET_CLOSE_MINUTE_ET = 0;

function etDateKey(parts: EtDateParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function getMarketCloseEt(parts: EtDateParts): EarlyCloseTime {
  const early = getEarlyCloses(parts.year).get(etDateKey(parts));
  return early ?? { hour: MARKET_CLOSE_HOUR_ET, minute: MARKET_CLOSE_MINUTE_ET };
}

function marketCloseUtcMs(parts: EtDateParts): number {
  const close = getMarketCloseEt(parts);
  return etWallClockToUtcMs(parts, close.hour, close.minute);
}

/** Latest ET trading-session date (YYYY-MM-DD) whose EOD bar should be present in cache. */
export function latestCompletedTradingSessionEtKey(nowMs: number = Date.now()): string {
  const today = etDateParts(new Date(nowMs));
  if (isEtCalendarTradingDay(today) && nowMs >= marketCloseUtcMs(today)) {
    return etDateKey(today);
  }

  let parts = today;
  for (let i = 0; i < 10; i++) {
    parts = addEtCalendarDays(parts, -1);
    if (isEtCalendarTradingDay(parts)) {
      return etDateKey(parts);
    }
  }
  return etDateKey(parts);
}

/** The next US equity session-open instant strictly after `nowMs`.  Regular hours open at
 *  9:30 ET; extended-hours accounts open at 4:00 ET.  Walks ET calendar days, bounded to 10
 *  iterations — the same bound as adjacentTradingDayStart — so a holiday-cluster bug cannot
 *  spin forever. */
export function nextSessionOpenMs(nowMs: number, runDuringExtendedHours = false): number {
  const openHour = runDuringExtendedHours ? 4 : MARKET_OPEN_HOUR_ET;
  const openMinute = runDuringExtendedHours ? 0 : MARKET_OPEN_MINUTE_ET;
  let parts = etDateParts(new Date(nowMs));
  for (let i = 0; i < 10; i++) {
    if (isEtCalendarTradingDay(parts)) {
      const openMs = etWallClockToUtcMs(parts, openHour, openMinute);
      if (openMs > nowMs) return openMs;
    }
    parts = addEtCalendarDays(parts, 1);
  }
  // Unreachable in practice (getMarketHolidays never clusters 10 consecutive non-trading days) —
  // fall back to whatever calendar day the loop ended on rather than looping forever.
  return etWallClockToUtcMs(parts, openHour, openMinute);
}

/** The next US equity market-open instant strictly after `nowMs` (regular 9:30 ET). */
function nextMarketOpenStrictlyAfterMs(nowMs: number): number {
  return nextSessionOpenMs(nowMs, false);
}

/** True when `nowMs` is already inside, or about to enter, a weekend/holiday closed stretch —
 *  i.e. today's ET calendar day, or tomorrow's, is NOT a trading day. This is what gates the TTL
 *  extension in expiresAtRespectingMarketClose to genuine multi-day closures: a routine overnight
 *  gap (e.g. Tuesday evening -> Wednesday morning) does NOT qualify, since both today and tomorrow
 *  are trading days. */
function isWeekendOrHolidayClosureAhead(nowMs: number): boolean {
  const today = etDateParts(new Date(nowMs));
  if (!isEtCalendarTradingDay(today)) return true;
  if (nowMs < marketCloseUtcMs(today)) return false;
  return !isEtCalendarTradingDay(addEtCalendarDays(today, 1));
}

/**
 * Extends a naive `now + baseTtlMs` cache expiry across a weekend/holiday closed stretch, so data
 * written before a weekend (or holiday) isn't needlessly re-fetched the moment its TTL lapses —
 * the market hasn't traded since and won't until the next open, so a refetch just burns provider
 * quota for identical data (LANE A: "stop weekend quota burn; keep Friday data served until
 * Monday"). Ordinary overnight gaps (e.g. Tuesday evening -> Wednesday morning) are NOT extended —
 * only a genuine multi-day closure qualifies. If baseTtlMs is already long enough that a real
 * session would open before the naive expiry — either because it's a routine same-week gap, or
 * because the TTL itself spans past the weekend into Monday — the naive expiry wins: extension
 * only ever pushes expiry LATER than naive, never earlier.
 */
export function expiresAtRespectingMarketClose(now: Date, baseTtlMs: number): number {
  const nowMs = now.getTime();
  const naiveExpiryMs = nowMs + baseTtlMs;
  if (!isWeekendOrHolidayClosureAhead(nowMs)) return naiveExpiryMs;
  const nextOpenMs = nextMarketOpenStrictlyAfterMs(nowMs);
  return naiveExpiryMs < nextOpenMs ? nextOpenMs : naiveExpiryMs;
}

function getGoodFriday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(Date.UTC(year, month, day));
  easter.setUTCDate(easter.getUTCDate() - 2);
  return easter;
}

export interface BrokerMarketHoursInfo {
  preMarket: string | null;
  regularHours: string;
  afterHours: string | null;
  scanHoursHint: string;
  orderHoursHint: string;
  syntheticStopHoursHint: string;
}

/**
 * Returns human-readable market hours and extended-hours hints for a given broker.
 */
export function getBrokerMarketHours(broker?: string): BrokerMarketHoursInfo {
  switch (broker) {
    case "robinhood":
      return {
        preMarket: "7:00 AM – 9:30 AM ET",
        regularHours: "9:30 AM – 4:00 PM ET",
        afterHours: "4:00 PM – 8:00 PM ET",
        scanHoursHint: "pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET",
        orderHoursHint: "Robinhood pre-market 7:00 AM – 9:30 AM ET, after-hours 4:00 PM – 8:00 PM ET (overnight 8:00 PM – 4:00 AM ET for supported symbols)",
        syntheticStopHoursHint: "pre-market 7:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET"
      };
    case "tradier":
      return {
        preMarket: "7:00 AM – 9:30 AM ET",
        regularHours: "9:30 AM – 4:00 PM ET",
        afterHours: "4:00 PM – 8:00 PM ET",
        scanHoursHint: "pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET",
        orderHoursHint: "Tradier pre-market 7:00 AM – 9:30 AM ET, after-hours 4:00 PM – 8:00 PM ET",
        syntheticStopHoursHint: "pre-market 7:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET"
      };
    case "public":
      return {
        preMarket: "8:00 AM – 9:30 AM ET",
        regularHours: "9:30 AM – 4:00 PM ET",
        afterHours: "4:00 PM – 8:00 PM ET",
        scanHoursHint: "pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET",
        orderHoursHint: "Public pre-market 8:00 AM – 9:30 AM ET, after-hours 4:00 PM – 8:00 PM ET",
        syntheticStopHoursHint: "pre-market 8:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET"
      };
    case "etoro":
      return {
        preMarket: null,
        regularHours: "9:30 AM – 4:00 PM ET",
        afterHours: null,
        scanHoursHint: "pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET",
        orderHoursHint: "Regular market hours only (9:30 AM – 4:00 PM ET; eToro does not support extended-hours trading)",
        syntheticStopHoursHint: "regular market hours only (9:30 AM – 4:00 PM ET)"
      };
    case "alpaca":
    case "alpaca-mcp":
    case "webull":
    case "test":
    default:
      return {
        preMarket: "4:00 AM – 9:30 AM ET",
        regularHours: "9:30 AM – 4:00 PM ET",
        afterHours: "4:00 PM – 8:00 PM ET",
        scanHoursHint: "pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET",
        orderHoursHint: "pre-market 4:00 AM – 9:30 AM ET, after-hours 4:00 PM – 8:00 PM ET",
        syntheticStopHoursHint: "pre-market 4:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET"
      };
  }
}

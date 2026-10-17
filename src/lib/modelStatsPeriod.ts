/** Calendar boundaries are local midnights, encoded as UTC epoch milliseconds.
 * Never add a fixed number of days: months, leap years and DST change their duration.
 */
export function modelStatsCalendarRange(period: "month" | "year", value: string): {
  startAtMs: number;
  endAtMs: number;
} | null {
  const match = (period === "month" ? /^(\d{4})-(\d{2})$/ : /^(\d{4})$/).exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = period === "month" ? Number(match[2]) - 1 : 0;
  if (year < 1 || year > 9998 || month < 0 || month > 11) return null;
  // setFullYear avoids Date's special handling of years 0–99.
  const start = new Date(0);
  start.setFullYear(year, month, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (period === "month") end.setMonth(month + 1);
  else end.setFullYear(year + 1);
  return { startAtMs: start.getTime(), endAtMs: end.getTime() };
}

export function shiftModelStatsCalendar(period: "month" | "year", value: string, offset: number): string | null {
  const range = modelStatsCalendarRange(period, value);
  if (!range) return null;
  const date = new Date(range.startAtMs);
  if (period === "month") date.setMonth(date.getMonth() + offset);
  else date.setFullYear(date.getFullYear() + offset);
  const year = String(date.getFullYear()).padStart(4, "0");
  const next = period === "month" ? `${year}-${String(date.getMonth() + 1).padStart(2, "0")}` : year;
  return modelStatsCalendarRange(period, next) ? next : null;
}

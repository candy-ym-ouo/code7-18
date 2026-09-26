import { z } from "zod";

/**
 * 地点开放时段引擎。
 *
 * 跨时区一致性原则：
 * - 墙上时间（如 09:00）只按地点绑定的 IANA 时区解释，与查询者时区无关。
 * - 计算结果一律物化为 UTC 即时（Date / timestamptz），任何时区的客户端
 *   查询同一即时都会得到相同答案。
 * - 当地日历日期运算在 UTC 日历上进行，避免 DST 影响日期加减。
 */

export const OPENING_EXCEPTION_KINDS = ["temporary_closure", "holiday"] as const;
export type OpeningExceptionKind = (typeof OPENING_EXCEPTION_KINDS)[number];

export const OPENING_WINDOWS_HORIZON_DAYS = 62;

export type LocalDate = { year: number; month: number; day: number };

export type OpeningWindow = {
  openAt: Date;
  closeAt: Date;
  source: "weekly" | "exception";
};

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式须为 HH:MM");
const closeTimeOfDaySchema = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "结束时间须为 HH:MM 或 24:00");

export const openingPeriodSchema = z.object({
  open: timeOfDaySchema,
  close: closeTimeOfDaySchema
}).strict();

export type OpeningPeriod = z.infer<typeof openingPeriodSchema>;

const dayPeriodsSchema = z.array(openingPeriodSchema).max(4);

export const weekPatternSchema = z.object({
  mon: dayPeriodsSchema.default([]),
  tue: dayPeriodsSchema.default([]),
  wed: dayPeriodsSchema.default([]),
  thu: dayPeriodsSchema.default([]),
  fri: dayPeriodsSchema.default([]),
  sat: dayPeriodsSchema.default([]),
  sun: dayPeriodsSchema.default([])
}).strict();

export type WeekPattern = z.infer<typeof weekPatternSchema>;

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const localDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式须为 YYYY-MM-DD")
  .refine(isValidCalendarDate, "日期不存在");

export const openingExceptionSchema = z.object({
  kind: z.enum(OPENING_EXCEPTION_KINDS),
  startsOn: localDateSchema,
  endsOn: localDateSchema,
  overridePeriods: z.array(openingPeriodSchema).max(4).nullable().optional(),
  reason: z.string().trim().max(200).optional()
}).strict().superRefine((value, context) => {
  if (value.endsOn < value.startsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "结束日期不能早于开始日期" });
  }
  if (value.kind === "temporary_closure" && value.overridePeriods?.length) {
    context.addIssue({ code: "custom", path: ["overridePeriods"], message: "临时闭馆为全天关闭，不支持覆盖时段" });
  }
});

export type OpeningExceptionInput = z.infer<typeof openingExceptionSchema>;

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export const upsertOpeningScheduleSchema = z.object({
  timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, "未知的 IANA 时区"),
  weekPattern: weekPatternSchema
}).strict();

export type UpsertOpeningScheduleInput = z.infer<typeof upsertOpeningScheduleSchema>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

type ZoneParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsInZone(instant: Date, timezone: string): ZoneParts {
  const result: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return {
    year: result.year!,
    month: result.month!,
    day: result.day!,
    hour: result.hour!,
    minute: result.minute!,
    second: result.second!
  };
}

/** 某 UTC 即时在目标时区的墙上读数与 UTC 的偏移（毫秒）。 */
export function getTzOffsetMs(instant: Date, timezone: string): number {
  const parts = partsInZone(instant, timezone);
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const instantSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return wallAsUtc - instantSeconds;
}

/** UTC 即时对应的当地日历日期。 */
export function localDateInZone(instant: Date, timezone: string): LocalDate {
  const parts = partsInZone(instant, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** 当地日历日期 + 墙上时间 → UTC 即时。DST 不存在的时间会顺延到最近的有效时间。 */
export function zonedLocalToUtc(timezone: string, date: LocalDate, time: string): Date {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hours, minutes);
  let utc = wallAsUtc - getTzOffsetMs(new Date(wallAsUtc), timezone);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = wallAsUtc - getTzOffsetMs(new Date(utc), timezone);
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
}

/** 日历日期加减，在 UTC 日历上运算，不受 DST 影响。 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export function localDateKey(date: LocalDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

export function parseLocalDate(value: string): LocalDate {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  return { year, month, day };
}

function weekdayKeyOf(date: LocalDate): (typeof WEEKDAY_KEYS)[number] {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return WEEKDAY_KEYS[weekday]!;
}

/** 合并重叠或首尾相接的窗口；含例外片段的合并窗口标记为 exception。 */
export function mergeWindows(windows: OpeningWindow[]): OpeningWindow[] {
  const sorted = [...windows].sort((a, b) => a.openAt.getTime() - b.openAt.getTime());
  const merged: OpeningWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.openAt.getTime() <= last.closeAt.getTime()) {
      if (window.closeAt.getTime() > last.closeAt.getTime()) last.closeAt = window.closeAt;
      if (window.source === "exception") last.source = "exception";
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * 由（时区 + 周期时段 + 例外）确定性地复算 UTC 开窗区间。
 * 从 horizonStart 前一天开始生成，以捕获跨午夜进入地平线的窗口。
 */
export function computeOpeningWindows(input: {
  timezone: string;
  weekPattern: WeekPattern;
  exceptions: OpeningExceptionInput[];
  horizonStart: LocalDate;
  horizonDays?: number;
}): OpeningWindow[] {
  if (!isValidTimeZone(input.timezone)) throw new Error(`Unknown timezone: ${input.timezone}`);
  const horizonDays = input.horizonDays ?? OPENING_WINDOWS_HORIZON_DAYS;

  const closures = new Set<string>();
  const overrides = new Map<string, OpeningPeriod[]>();
  for (const exception of input.exceptions) {
    let cursor = parseLocalDate(exception.startsOn);
    const endKey = localDateKey(parseLocalDate(exception.endsOn));
    while (localDateKey(cursor) <= endKey) {
      const key = localDateKey(cursor);
      if (exception.kind === "temporary_closure" || !exception.overridePeriods?.length) {
        closures.add(key);
        overrides.delete(key);
      } else if (!closures.has(key)) {
        overrides.set(key, [...(overrides.get(key) ?? []), ...exception.overridePeriods]);
      }
      cursor = addDays(cursor, 1);
    }
  }

  const intervals: OpeningWindow[] = [];
  const horizonEnd = addDays(input.horizonStart, horizonDays);
  let cursor = addDays(input.horizonStart, -1);
  while (localDateKey(cursor) < localDateKey(horizonEnd)) {
    const key = localDateKey(cursor);
    let periods: OpeningPeriod[] = [];
    let source: OpeningWindow["source"] = "weekly";
    if (!closures.has(key)) {
      const override = overrides.get(key);
      if (override) {
        periods = override;
        source = "exception";
      } else {
        periods = input.weekPattern[weekdayKeyOf(cursor)] ?? [];
      }
    }
    for (const period of periods) {
      const openAt = zonedLocalToUtc(input.timezone, cursor, period.open);
      const crossesMidnight = period.close <= period.open;
      const closeDate = crossesMidnight || period.close === "24:00" ? addDays(cursor, 1) : cursor;
      const closeTime = period.close === "24:00" ? "00:00" : period.close;
      const closeAt = zonedLocalToUtc(input.timezone, closeDate, closeTime);
      if (closeAt.getTime() > openAt.getTime()) intervals.push({ openAt, closeAt, source });
    }
    cursor = addDays(cursor, 1);
  }

  const horizonStartUtc = zonedLocalToUtc(input.timezone, input.horizonStart, "00:00");
  const relevant = intervals.filter((window) => window.closeAt.getTime() > horizonStartUtc.getTime());
  return mergeWindows(relevant);
}

/** 比较两个已排序窗口序列的开闭区间是否一致（source 不参与，用户只关心开不开门）。 */
export function windowsEqual(a: OpeningWindow[], b: OpeningWindow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((window, index) =>
    window.openAt.getTime() === b[index]!.openAt.getTime() &&
    window.closeAt.getTime() === b[index]!.closeAt.getTime()
  );
}

/** 某 UTC 即时的开放状态。windows 必须按 openAt 升序。 */
export function openingStatusAt(windows: OpeningWindow[], at: Date): {
  isOpen: boolean;
  currentWindow: OpeningWindow | null;
  nextWindow: OpeningWindow | null;
} {
  let currentWindow: OpeningWindow | null = null;
  let nextWindow: OpeningWindow | null = null;
  for (const window of windows) {
    if (window.openAt.getTime() <= at.getTime() && at.getTime() < window.closeAt.getTime()) {
      currentWindow = window;
    } else if (window.openAt.getTime() > at.getTime()) {
      nextWindow = window;
      break;
    }
  }
  return { isOpen: currentWindow !== null, currentWindow, nextWindow };
}

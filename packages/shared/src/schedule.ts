import { z } from "zod";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

export const timeString = z
  .string()
  .regex(/^(\d{2}):(\d{2})$/, "时间必须是 HH:MM 格式")
  .refine((value) => {
    const [hour, minute] = value.split(":").map(Number);
    return (hour ?? 0) <= 23 && (minute ?? 0) <= 59;
  }, "时间超出范围");

export const weekdayPeriodInputSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: timeString,
  // 结束时间晚于开始=同日结束；早于或等于开始=跨夜（营业到次日该时刻）
  endTime: timeString,
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional()
});

export const exceptionInputSchema = z.object({
  kind: z.enum(["closed", "open"]),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // closed 时省略=全天闭馆，给出时段=仅该时段闭馆；open 时必填开放时段
  startTime: timeString.nullable().optional(),
  endTime: timeString.nullable().optional(),
  reason: z.string().trim().min(1).max(200)
}).superRefine((value, context) => {
  if (value.endLocalDate && value.endLocalDate < value.localDate) {
    context.addIssue({ code: "custom", path: ["endLocalDate"], message: "结束日期不能早于开始日期" });
  }
  if (value.kind === "open") {
    if (!value.startTime || !value.endTime) {
      context.addIssue({ code: "custom", path: ["startTime"], message: "节假日特别开放必须填写开放时段" });
    }
  } else if ((value.startTime === null) !== (value.endTime === null)) {
    context.addIssue({ code: "custom", path: ["endTime"], message: "开始时间和结束时间必须同时提供" });
  }
});

export const scheduleSettingsSchema = z.object({
  timezone: z.string().trim().min(1).max(64)
});

export const weekdayPeriodReplaceSchema = z.object({
  periods: z.array(weekdayPeriodInputSchema).max(49).superRefine((periods, context) => {
    for (const period of periods) {
      if (period.validFrom && period.validTo && period.validFrom > period.validTo) {
        context.addIssue({ code: "custom", path: ["validFrom"], message: "生效起始不能晚于结束" });
      }
    }
  })
});

export type WeekdayPeriodInput = z.infer<typeof weekdayPeriodInputSchema>;
export type ExceptionInput = z.infer<typeof exceptionInputSchema>;

export type WeekdayPeriodRule = {
  id?: string;
  weekday: number;
  startMinutes: number;
  durationMinutes: number;
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
};

export type ExceptionRule = {
  id?: string;
  kind: "closed" | "open";
  localDate: string;
  endLocalDate: string | null;
  // 全天闭馆时为 null
  startMinutes: number | null;
  durationMinutes: number | null;
  reason: string;
  /** ISO 时间戳，用于同日多条例外时“后创建的优先” */
  createdAt?: string;
};

export type ScheduleSnapshot = {
  timezone: string;
  weekly: WeekdayPeriodRule[];
  exceptions: ExceptionRule[];
};

export function minutesToTime(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export function isValidTimeZone(value: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 时区换算：本地"墙上时间" -> UTC，DST 行为确定
// ---------------------------------------------------------------------------

type WallToUtcOptions = {
  /** 不存在的本地时间（春令时跳变）：向前推到跳变后；向后拉到跳变前 */
  gapPolicy?: "forward" | "backward";
  /** 回退歧义（秋令时）：取第一次出现（DST 偏移）还是第二次（标准偏移） */
  overlapPolicy?: "earlier" | "later";
};

/**
 * 把某地时区的本地日期时间转换为 UTC 毫秒。
 * - 不存在时间（春季跳过的小时）：默认向前夹到跳变后（PostgreSQL 行为）。
 * - 歧义时间（秋季重复的小时）：默认取第二次出现（标准时间），与 PostgreSQL
 *   timestamp AT TIME ZONE 的后转歧义解析一致。
 */
export function wallTimeToUtcMs(
  timeZone: string,
  localDate: string,
  minutesOfDay: number,
  options: WallToUtcOptions = {}
): number {
  const { gapPolicy = "forward", overlapPolicy = "later" } = options;
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const localEpochMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // 用本地日两个锚点的偏移构造候选瞬间：00:00 用当日偏移，23:59 用临近午夜偏移，
  // 二者不同即表示当日发生 DST 跳变。
  const midnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetAtStart = offsetMinutesAtUtc(timeZone, midnightUtc);
  const offsetAtEnd = offsetMinutesAtUtc(timeZone, Date.UTC(year, month - 1, day, 23, 59, 0));
  const candidateOffsets = offsetAtStart === offsetAtEnd ? [offsetAtStart] : [offsetAtStart, offsetAtEnd];

  const matches: number[] = [];
  for (const offset of candidateOffsets) {
    const instant = localEpochMs - offset * 60_000;
    // 用该瞬间真实偏移反推回本地墙上分钟，验证与目标一致
    const actualOffset = offsetMinutesAtUtc(timeZone, instant);
    const localDayStart = Date.UTC(year, month - 1, day, 0, 0, 0);
    const wallMinutes = (instant + actualOffset * 60_000 - localDayStart) / 60_000;
    if (wallMinutes === minutesOfDay && !matches.includes(instant)) matches.push(instant);
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length >= 2) {
    // 秋季回退：earlier=第一次（DST），later=第二次（标准时间）
    matches.sort((a, b) => a - b);
    return overlapPolicy === "earlier" ? matches[0]! : matches[matches.length - 1]!;
  }

  // 春季跳变（无匹配）：当日偏移在 gap 前后各保持一个值。二分定位跳变的 UTC 瞬间，
  // forward/backward 都返回该边界——gap 内的墙上分钟本就不存在，夹到同一边界即可。
  // （窗口起止用 forward：结束落在 gap 内夹到跳变点，保证 start < end 与语义正确。）
  const dayStartUtcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const transitionUtc = binarySearchTransition(
    timeZone,
    dayStartUtcGuess,
    Date.UTC(year, month - 1, day + 1, 0, 0, 0)
  );
  if (transitionUtc === null) return localEpochMs - Math.max(offsetAtStart, offsetAtEnd) * 60_000;
  return transitionUtc;
}

/** 在 [lo, hi) UTC 区间内二分查找偏移发生变化的边界瞬间（返回偏移变为 after 的第一毫秒）。 */
function binarySearchTransition(timeZone: string, lo: number, hi: number): number | null {
  const offsetLo = offsetMinutesAtUtc(timeZone, lo);
  const offsetHi = offsetMinutesAtUtc(timeZone, hi);
  if (offsetLo === offsetHi) return null;
  let left = lo;
  let right = hi;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (offsetMinutesAtUtc(timeZone, mid) === offsetLo) left = mid + 1;
    else right = mid;
  }
  return left === hi ? null : left;
}

/** 给定 UTC 瞬间，某时区相对 UTC 的偏移（分钟，东为正）。 */
export function offsetMinutesAtUtc(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(map.year!, map.month! - 1, map.day!, (map.hour ?? 0) % 24, map.minute ?? 0, map.second ?? 0);
  return Math.round((asUtc - utcMs) / 60_000);
}

/** UTC 瞬间在该时区的本地日期（YYYY-MM-DD）。 */
export function localDateAtUtc(timeZone: string, utcMs: number): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  return dtf.format(new Date(utcMs));
}

// ---------------------------------------------------------------------------
// 开放窗口计算（查询与复算共用的唯一实现）
// ---------------------------------------------------------------------------

export type OpenWindow = {
  startAt: Date;
  endAt: Date;
  source: "weekly" | "exception_open";
  /** 规则归属的本地日期；跨夜窗口归开始日 */
  localDate: string;
  weekday: number;
};

export type OpenStatus = {
  state: "open" | "closed" | "unknown";
  /** state=open 时当前开放窗口的结束时刻 */
  closesAt: Date | null;
  /** 闭馆状态下的下一个开放窗口开始时刻（查询范围内） */
  nextOpenAt: Date | null;
};

const MS = 60_000;

function isoWeekdayOf(localDate: string): number {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addLocalDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function datesBetween(fromLocal: string, toLocal: string): string[] {
  const dates: string[] = [];
  for (let date = fromLocal; date <= toLocal; date = addLocalDays(date, 1)) dates.push(date);
  return dates;
}

function periodActiveOn(period: WeekdayPeriodRule, date: string, weekday: number): boolean {
  if (period.weekday !== weekday) return false;
  if (period.validFrom && date < period.validFrom) return false;
  if (period.validTo && date > period.validTo) return false;
  return true;
}

function exceptionOnDate(rule: ExceptionRule, date: string): ExceptionRule | null {
  const end = rule.endLocalDate ?? rule.localDate;
  if (date >= rule.localDate && date <= end) return rule;
  return null;
}

type UtcInterval = { startUtcMs: number; endUtcMs: number };
type RawOpen = UtcInterval & { source: "weekly" | "exception_open"; localDate: string };

/**
 * 计算 [rangeStartUtc, rangeEndUtc) 内的开放窗口（UTC 半开区间，已排序、已合并相邻区间）。
 *
 * 每个本地日期的生效规则：closed 例外（全天/时段）优先；否则 open 例外当日仅例外时段开放；
 * 否则按每周周期。跨夜窗口按开始的本地日归属；例外通过 UTC 区间差集裁切，天然处理跨夜溢出。
 */
export function computeOpenWindows(
  snapshot: ScheduleSnapshot,
  rangeStartUtc: Date,
  rangeEndUtc: Date
): OpenWindow[] {
  const { timezone } = snapshot;
  // 起点本地日向前多取一天，覆盖前一日开始的跨夜窗口
  const firstLocal = addLocalDays(localDateAtUtc(timezone, rangeStartUtc.getTime()), -1);
  const lastLocal = localDateAtUtc(timezone, rangeEndUtc.getTime());

  const opens: RawOpen[] = [];
  const closedRegions: UtcInterval[] = [];

  for (const date of datesBetween(firstLocal, lastLocal)) {
    const weekday = isoWeekdayOf(date);
    const exception = snapshot.exceptions
      .filter((rule) => exceptionOnDate(rule, date))
      // 同日多条：后创建的优先（以 createdAt 为准，id 仅兜底）
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || String(b.id ?? "").localeCompare(String(a.id ?? "")))[0];

    const dayStart = wallTimeToUtcMs(timezone, date, 0);
    const dayEnd = wallTimeToUtcMs(timezone, addLocalDays(date, 1), 0);

    if (exception?.kind === "closed") {
      if (exception.startMinutes === null) {
        // 全天闭馆：闭掉整个本地日（同时截掉前一日跨夜溢出）
        closedRegions.push({ startUtcMs: dayStart, endUtcMs: dayEnd });
      } else {
        closedRegions.push(buildUtcInterval(timezone, date, exception.startMinutes, exception.durationMinutes!));
        // 闭馆时段之外仍按周期开放
        for (const period of snapshot.weekly.filter((p) => periodActiveOn(p, date, weekday))) {
          opens.push({
            ...buildUtcInterval(timezone, date, period.startMinutes, period.durationMinutes),
            source: "weekly",
            localDate: date
          });
        }
      }
    } else if (exception?.kind === "open") {
      const openInterval = buildUtcInterval(timezone, date, exception.startMinutes!, exception.durationMinutes!);
      // 当日仅例外时段开放：闭掉开段之前（含前一日跨夜溢出）与之后
      closedRegions.push({ startUtcMs: dayStart, endUtcMs: openInterval.startUtcMs });
      closedRegions.push({ startUtcMs: openInterval.endUtcMs, endUtcMs: dayEnd });
      opens.push({ ...openInterval, source: "exception_open", localDate: date });
    } else {
      for (const period of snapshot.weekly.filter((p) => periodActiveOn(p, date, weekday))) {
        opens.push({
          ...buildUtcInterval(timezone, date, period.startMinutes, period.durationMinutes),
          source: "weekly",
          localDate: date
        });
      }
    }
  }

  // 合并闭区间，再对开放段做差集
  const mergedClosed = mergeIntervals(closedRegions);
  let pieces: Array<UtcInterval & { sources: RawOpen[] }> = opens.map((open) => ({
    startUtcMs: open.startUtcMs,
    endUtcMs: open.endUtcMs,
    sources: [open]
  }));
  for (const region of mergedClosed) {
    pieces = pieces.flatMap((piece) =>
      subtract(piece, region).map((interval) => ({ ...interval, sources: piece.sources }))
    );
  }

  // 合并重叠/相邻开放段，保留来源用于判定 exception_open
  pieces.sort((a, b) => a.startUtcMs - b.startUtcMs || b.endUtcMs - a.endUtcMs);
  const mergedPieces: Array<UtcInterval & { sources: RawOpen[] }> = [];
  for (const piece of pieces) {
    const previous = mergedPieces[mergedPieces.length - 1];
    if (previous && piece.startUtcMs <= previous.endUtcMs) {
      previous.endUtcMs = Math.max(previous.endUtcMs, piece.endUtcMs);
      previous.sources = previous.sources.concat(piece.sources);
    } else {
      mergedPieces.push({ ...piece, sources: [...piece.sources] });
    }
  }

  const rangeStartMs = rangeStartUtc.getTime();
  const rangeEndMs = rangeEndUtc.getTime();
  return mergedPieces
    .filter((interval) => interval.endUtcMs > rangeStartMs && interval.startUtcMs < rangeEndMs)
    .map((interval) => {
      const startUtcMs = Math.max(interval.startUtcMs, rangeStartMs);
      const endUtcMs = Math.min(interval.endUtcMs, rangeEndMs);
      const source = interval.sources.some((s) => s.source === "exception_open")
        ? "exception_open" as const
        : "weekly" as const;
      // 裁切后起点可能落在合并段中间，归到包含起点的原始段
      const owner = interval.sources.find((s) => s.startUtcMs <= startUtcMs && s.endUtcMs > startUtcMs)
        ?? interval.sources[0]!;
      return {
        startAt: new Date(startUtcMs),
        endAt: new Date(endUtcMs),
        source,
        localDate: owner.localDate,
        weekday: isoWeekdayOf(owner.localDate)
      };
    });
}

function buildUtcInterval(
  timeZone: string,
  date: string,
  startMinutes: number,
  durationMinutes: number
): UtcInterval {
  const startUtcMs = wallTimeToUtcMs(timeZone, date, startMinutes);
  const endMinutes = startMinutes + durationMinutes;
  const endUtcMs = wallTimeToUtcMs(timeZone, addLocalDays(date, endMinutes >= 1440 ? 1 : 0), endMinutes % 1440);
  return { startUtcMs, endUtcMs };
}

function mergeIntervals(intervals: UtcInterval[]): UtcInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startUtcMs - b.startUtcMs);
  const merged: UtcInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startUtcMs <= previous.endUtcMs) {
      previous.endUtcMs = Math.max(previous.endUtcMs, interval.endUtcMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function subtract(interval: UtcInterval, hole: UtcInterval): UtcInterval[] {
  if (hole.endUtcMs <= interval.startUtcMs || hole.startUtcMs >= interval.endUtcMs) return [interval];
  const pieces: UtcInterval[] = [];
  if (hole.startUtcMs > interval.startUtcMs) {
    pieces.push({ startUtcMs: interval.startUtcMs, endUtcMs: Math.min(hole.startUtcMs, interval.endUtcMs) });
  }
  if (hole.endUtcMs < interval.endUtcMs) {
    pieces.push({ startUtcMs: Math.max(hole.endUtcMs, interval.startUtcMs), endUtcMs: interval.endUtcMs });
  }
  return pieces;
}

/** 某时刻的开放状态；lookaheadMs 内找不到下一开放窗口则 nextOpenAt 为 null。 */
export function computeOpenStatus(
  snapshot: ScheduleSnapshot | null,
  atUtc: Date,
  lookaheadMs = 14 * 24 * 3600 * 1000
): OpenStatus {
  if (!snapshot) return { state: "unknown", closesAt: null, nextOpenAt: null };
  const windows = computeOpenWindows(snapshot, new Date(atUtc.getTime() - MS), new Date(atUtc.getTime() + lookaheadMs));
  const at = atUtc.getTime();
  const current = windows.find((w) => w.startAt.getTime() <= at && w.endAt.getTime() > at);
  if (current) {
    return { state: "open", closesAt: current.endAt, nextOpenAt: null };
  }
  const next = windows.find((w) => w.startAt.getTime() > at);
  return { state: "closed", closesAt: null, nextOpenAt: next?.startAt ?? null };
}

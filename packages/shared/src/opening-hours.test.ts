import { describe, expect, it } from "vitest";
import {
  addDays,
  computeOpeningWindows,
  getTzOffsetMs,
  isValidTimeZone,
  localDateInZone,
  localDateKey,
  mergeWindows,
  openingExceptionSchema,
  openingStatusAt,
  parseLocalDate,
  upsertOpeningScheduleSchema,
  weekPatternSchema,
  windowsEqual,
  zonedLocalToUtc,
  type OpeningWindow
} from "./opening-hours";

const everydayNineToFive = weekPatternSchema.parse({
  mon: [{ open: "09:00", close: "17:00" }],
  tue: [{ open: "09:00", close: "17:00" }],
  wed: [{ open: "09:00", close: "17:00" }],
  thu: [{ open: "09:00", close: "17:00" }],
  fri: [{ open: "09:00", close: "17:00" }],
  sat: [{ open: "09:00", close: "17:00" }],
  sun: [{ open: "09:00", close: "17:00" }]
});

function windowAt(windows: OpeningWindow[], iso: string): OpeningWindow | undefined {
  const at = new Date(iso).getTime();
  return windows.find((window) => window.openAt.getTime() <= at && at < window.closeAt.getTime());
}

describe("时区工具", () => {
  it("校验 IANA 时区名称", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("计算固定时区与 DST 时区的偏移", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    const summer = new Date("2026-07-15T12:00:00Z");
    expect(getTzOffsetMs(winter, "Asia/Shanghai")).toBe(8 * 3600_000);
    expect(getTzOffsetMs(winter, "America/New_York")).toBe(-5 * 3600_000);
    expect(getTzOffsetMs(summer, "America/New_York")).toBe(-4 * 3600_000);
  });

  it("墙上时间按地点时区换算为 UTC 即时", () => {
    const open = zonedLocalToUtc("Asia/Shanghai", { year: 2026, month: 6, day: 1 }, "09:00");
    expect(open.toISOString()).toBe("2026-06-01T01:00:00.000Z");
    const openNy = zonedLocalToUtc("America/New_York", { year: 2026, month: 6, day: 1 }, "09:00");
    expect(openNy.toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  it("UTC 即时可还原为当地日历日期", () => {
    // 同一 UTC 即时落在不同当地日期
    const instant = new Date("2026-06-01T16:30:00Z");
    expect(localDateKey(localDateInZone(instant, "UTC"))).toBe("2026-06-01");
    expect(localDateKey(localDateInZone(instant, "Pacific/Auckland"))).toBe("2026-06-02");
    expect(localDateKey(localDateInZone(instant, "America/Los_Angeles"))).toBe("2026-06-01");
  });

  it("日历日期加减跨越月末与年末", () => {
    expect(localDateKey(addDays({ year: 2026, month: 1, day: 31 }, 1))).toBe("2026-02-01");
    expect(localDateKey(addDays({ year: 2026, month: 12, day: 31 }, 1))).toBe("2027-01-01");
    expect(localDateKey(addDays({ year: 2026, month: 3, day: 1 }, -1))).toBe("2026-02-28");
    expect(localDateKey(parseLocalDate("2026-02-28"))).toBe("2026-02-28");
  });
});

describe("computeOpeningWindows", () => {
  const horizonStart = { year: 2026, month: 6, day: 1 }; // 周一

  it("按地点时区生成 UTC 窗口，与查询者时区无关", () => {
    const windows = computeOpeningWindows({
      timezone: "Asia/Shanghai",
      weekPattern: everydayNineToFive,
      exceptions: [],
      horizonStart,
      horizonDays: 7
    });
    // 上海 09:00 = UTC 01:00，无论谁在查询都一样
    expect(windows[0]!.openAt.toISOString()).toBe("2026-06-01T01:00:00.000Z");
    expect(windows[0]!.closeAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(windows).toHaveLength(7);
  });

  it("支持跨午夜时段", () => {
    const pattern = weekPatternSchema.parse({ fri: [{ open: "22:00", close: "02:00" }] });
    const windows = computeOpeningWindows({
      timezone: "UTC",
      weekPattern: pattern,
      exceptions: [],
      horizonStart,
      horizonDays: 7
    });
    const friday = windows.find((window) => window.openAt.toISOString() === "2026-06-05T22:00:00.000Z");
    expect(friday?.closeAt.toISOString()).toBe("2026-06-06T02:00:00.000Z");
  });

  it("24:00 表示当天结束", () => {
    const pattern = weekPatternSchema.parse({ mon: [{ open: "08:00", close: "24:00" }] });
    const windows = computeOpeningWindows({
      timezone: "UTC",
      weekPattern: pattern,
      exceptions: [],
      horizonStart,
      horizonDays: 2
    });
    expect(windows[0]!.openAt.toISOString()).toBe("2026-06-01T08:00:00.000Z");
    expect(windows[0]!.closeAt.toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });

  it("临时闭馆覆盖周期时段", () => {
    const windows = computeOpeningWindows({
      timezone: "UTC",
      weekPattern: everydayNineToFive,
      exceptions: [{ kind: "temporary_closure", startsOn: "2026-06-03", endsOn: "2026-06-04", reason: "设备检修" }],
      horizonStart,
      horizonDays: 7
    });
    expect(windows).toHaveLength(5);
    expect(windowAt(windows, "2026-06-03T10:00:00Z")).toBeUndefined();
    expect(windowAt(windows, "2026-06-05T10:00:00Z")).toBeDefined();
  });

  it("节假日例外可全天关闭或覆盖时段", () => {
    const windows = computeOpeningWindows({
      timezone: "UTC",
      weekPattern: everydayNineToFive,
      exceptions: [
        { kind: "holiday", startsOn: "2026-06-03", endsOn: "2026-06-03", reason: "公共假日" },
        { kind: "holiday", startsOn: "2026-06-05", endsOn: "2026-06-05", overridePeriods: [{ open: "10:00", close: "14:00" }] }
      ],
      horizonStart,
      horizonDays: 7
    });
    expect(windowAt(windows, "2026-06-03T10:00:00Z")).toBeUndefined();
    expect(windowAt(windows, "2026-06-05T09:30:00Z")).toBeUndefined();
    const override = windowAt(windows, "2026-06-05T11:00:00Z");
    expect(override?.source).toBe("exception");
    expect(override?.closeAt.toISOString()).toBe("2026-06-05T14:00:00.000Z");
  });

  it("同一天临时闭馆优先于节假日覆盖时段", () => {
    const windows = computeOpeningWindows({
      timezone: "UTC",
      weekPattern: everydayNineToFive,
      exceptions: [
        { kind: "holiday", startsOn: "2026-06-03", endsOn: "2026-06-03", overridePeriods: [{ open: "10:00", close: "14:00" }] },
        { kind: "temporary_closure", startsOn: "2026-06-03", endsOn: "2026-06-03" }
      ],
      horizonStart,
      horizonDays: 7
    });
    expect(windowAt(windows, "2026-06-03T11:00:00Z")).toBeUndefined();
  });

  it("地平线起始日凌晨的跨午夜窗口不会丢失", () => {
    const pattern = weekPatternSchema.parse({ sun: [{ open: "22:00", close: "02:00" }] });
    const windows = computeOpeningWindows({
      timezone: "UTC",
      weekPattern: pattern,
      exceptions: [],
      horizonStart, // 周一；周日晚 22:00 的窗口跨午夜进入周一
      horizonDays: 3
    });
    const carry = windows.find((window) => window.closeAt.toISOString() === "2026-06-01T02:00:00.000Z");
    expect(carry).toBeDefined();
  });

  it("DST 春季切换前后窗口保持一致（America/New_York）", () => {
    // 2026-03-08 凌晨 02:00 纽约 EST→EDT；切换前一天 09:00 是 EST（UTC-5），当天起 09:00 是 EDT（UTC-4）
    const windows = computeOpeningWindows({
      timezone: "America/New_York",
      weekPattern: everydayNineToFive,
      exceptions: [],
      horizonStart: { year: 2026, month: 3, day: 7 },
      horizonDays: 3
    });
    const [saturday, sunday] = windows;
    expect(saturday!.openAt.toISOString()).toBe("2026-03-07T14:00:00.000Z"); // EST 09:00
    expect(saturday!.closeAt.toISOString()).toBe("2026-03-07T22:00:00.000Z"); // EST 17:00
    expect(sunday!.openAt.toISOString()).toBe("2026-03-08T13:00:00.000Z"); // EDT 09:00
    expect(sunday!.closeAt.toISOString()).toBe("2026-03-08T21:00:00.000Z"); // EDT 17:00
    expect(sunday!.closeAt.getTime() - sunday!.openAt.getTime()).toBe(8 * 3600_000);
  });

  it("合并重叠与相邻窗口", () => {
    const pattern = weekPatternSchema.parse({
      mon: [
        { open: "09:00", close: "12:00" },
        { open: "12:00", close: "18:00" }
      ]
    });
    const windows = computeOpeningWindows({
      timezone: "UTC",
      weekPattern: pattern,
      exceptions: [],
      horizonStart,
      horizonDays: 2
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.openAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(windows[0]!.closeAt.toISOString()).toBe("2026-06-01T18:00:00.000Z");
  });
});

describe("跨时区查询一致性", () => {
  it("同一 UTC 即时在任何渲染时区下得到相同开放状态", () => {
    const windows = computeOpeningWindows({
      timezone: "Asia/Shanghai",
      weekPattern: everydayNineToFive,
      exceptions: [],
      horizonStart: { year: 2026, month: 6, day: 1 },
      horizonDays: 7
    });
    // 上海时间 2026-06-02 10:30 = UTC 02:30 = 纽约 2026-06-01 22:30（前一天晚上）
    const instant = new Date("2026-06-02T02:30:00Z");
    expect(localDateKey(localDateInZone(instant, "Asia/Shanghai"))).toBe("2026-06-02");
    expect(localDateKey(localDateInZone(instant, "America/New_York"))).toBe("2026-06-01");
    const status = openingStatusAt(windows, instant);
    expect(status.isOpen).toBe(true);
    expect(status.currentWindow?.openAt.toISOString()).toBe("2026-06-02T01:00:00.000Z");
    // 闭馆时段查询
    const closed = openingStatusAt(windows, new Date("2026-06-02T12:00:00Z")); // 上海 20:00
    expect(closed.isOpen).toBe(false);
    expect(closed.nextWindow?.openAt.toISOString()).toBe("2026-06-03T01:00:00.000Z");
  });

  it("复算是确定性的：相同输入产生相同窗口", () => {
    const input = {
      timezone: "Europe/Berlin",
      weekPattern: everydayNineToFive,
      exceptions: [{ kind: "temporary_closure" as const, startsOn: "2026-06-04", endsOn: "2026-06-04" }],
      horizonStart: { year: 2026, month: 6, day: 1 },
      horizonDays: 14
    };
    const first = computeOpeningWindows(input);
    const second = computeOpeningWindows(input);
    expect(windowsEqual(first, second)).toBe(true);
  });

  it("windowsEqual 只比较开闭区间", () => {
    const a: OpeningWindow[] = [{ openAt: new Date("2026-06-01T01:00:00Z"), closeAt: new Date("2026-06-01T09:00:00Z"), source: "weekly" }];
    const b: OpeningWindow[] = [{ openAt: new Date("2026-06-01T01:00:00Z"), closeAt: new Date("2026-06-01T09:00:00Z"), source: "exception" }];
    expect(windowsEqual(a, b)).toBe(true);
    expect(windowsEqual(a, mergeWindows([]))).toBe(false);
  });
});

describe("合约校验", () => {
  it("接受合法的周期时段与例外", () => {
    const schedule = upsertOpeningScheduleSchema.safeParse({
      timezone: "Asia/Shanghai",
      weekPattern: { mon: [{ open: "09:00", close: "17:00" }] }
    });
    expect(schedule.success).toBe(true);
    const exception = openingExceptionSchema.safeParse({
      kind: "holiday",
      startsOn: "2026-10-01",
      endsOn: "2026-10-07",
      overridePeriods: [{ open: "10:00", close: "16:00" }],
      reason: "国庆假期"
    });
    expect(exception.success).toBe(true);
  });

  it("拒绝未知时区、非法时间与不存在的日期", () => {
    expect(upsertOpeningScheduleSchema.safeParse({ timezone: "Mars/Olympus", weekPattern: {} }).success).toBe(false);
    expect(weekPatternSchema.safeParse({ mon: [{ open: "25:00", close: "26:00" }] }).success).toBe(false);
    expect(openingExceptionSchema.safeParse({ kind: "holiday", startsOn: "2026-02-30", endsOn: "2026-03-01" }).success).toBe(false);
  });

  it("拒绝结束日期早于开始日期与临时闭馆携带覆盖时段", () => {
    expect(openingExceptionSchema.safeParse({ kind: "holiday", startsOn: "2026-10-07", endsOn: "2026-10-01" }).success).toBe(false);
    expect(openingExceptionSchema.safeParse({
      kind: "temporary_closure",
      startsOn: "2026-10-01",
      endsOn: "2026-10-02",
      overridePeriods: [{ open: "10:00", close: "12:00" }]
    }).success).toBe(false);
  });
});

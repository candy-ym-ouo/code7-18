import { describe, expect, it } from "vitest";
import {
  computeOpenStatus,
  computeOpenWindows,
  localDateAtUtc,
  minutesToTime,
  timeToMinutes,
  wallTimeToUtcMs,
  type ScheduleSnapshot
} from "./schedule";

const shanghai = (weekly: ScheduleSnapshot["weekly"], exceptions: ScheduleSnapshot["exceptions"] = []): ScheduleSnapshot => ({
  timezone: "Asia/Shanghai",
  weekly,
  exceptions
});

// 每天 09:00–18:00
const dailyNineToSix = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinutes: 9 * 60,
  durationMinutes: 9 * 60,
  validFrom: null,
  validTo: null,
  note: null
}));

describe("time helpers", () => {
  it("converts HH:MM and minutes symmetrically", () => {
    expect(timeToMinutes("09:30")).toBe(570);
    expect(minutesToTime(570)).toBe("09:30");
    expect(minutesToTime(1440)).toBe("00:00");
  });

  it("converts wall time to UTC with fixed offsets", () => {
    // 上海 +08:00：本地 09:00 -> UTC 01:00
    expect(new Date(wallTimeToUtcMs("Asia/Shanghai", "2026-05-01", 540)).toISOString()).toBe("2026-05-01T01:00:00.000Z");
    // 纽约 -04:00（夏令时）
    expect(new Date(wallTimeToUtcMs("America/New_York", "2026-07-01", 9 * 60)).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    // UTC
    expect(new Date(wallTimeToUtcMs("UTC", "2026-05-01", 0)).toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("handles the spring-forward gap by clamping forward", () => {
    // 纽约 2026-03-08 02:30 不存在；02:00 -> 03:00 跳变，夹到 03:00（UTC 07:00）
    expect(new Date(wallTimeToUtcMs("America/New_York", "2026-03-08", 150)).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("resolves the fall-back ambiguous time to the second occurrence (standard time)", () => {
    // 纽约 2026-11-01 01:30 出现两次；第二次（EST, UTC-05）= 06:30Z
    expect(new Date(wallTimeToUtcMs("America/New_York", "2026-11-01", 90)).toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // earlier 取第一次（EDT, UTC-04）= 05:30Z
    expect(new Date(wallTimeToUtcMs("America/New_York", "2026-11-01", 90, { overlapPolicy: "earlier" })).toISOString())
      .toBe("2026-11-01T05:30:00.000Z");
  });

  it("derives local dates consistently across time zones", () => {
    // 2026-05-01T20:00Z：上海已是 5 月 2 日，纽约仍是 5 月 1 日
    const instant = Date.parse("2026-05-01T20:00:00Z");
    expect(localDateAtUtc("Asia/Shanghai", instant)).toBe("2026-05-02");
    expect(localDateAtUtc("America/New_York", instant)).toBe("2026-05-01");
    expect(localDateAtUtc("UTC", instant)).toBe("2026-05-01");
  });
});

describe("computeOpenWindows", () => {
  it("produces UTC windows for a weekly schedule", () => {
    const windows = computeOpenWindows(
      shanghai(dailyNineToSix),
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-03T00:00:00Z")
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]!.startAt.toISOString()).toBe("2026-05-01T01:00:00.000Z");
    expect(windows[0]!.endAt.toISOString()).toBe("2026-05-01T10:00:00.000Z");
    expect(windows.every((w) => w.source === "weekly")).toBe(true);
  });

  it("returns identical windows regardless of the observer time zone", () => {
    const range = [new Date("2026-05-01T00:00:00Z"), new Date("2026-05-08T00:00:00Z")] as const;
    const snapshot = shanghai(dailyNineToSix);
    const inShanghai = computeOpenWindows(snapshot, range[0], range[1]);
    const snapshotNy: ScheduleSnapshot = { ...snapshot, timezone: "Asia/Shanghai" };
    // 快照携带时区，查询方在哪个时区调用结果都相同
    const inNewYork = computeOpenWindows(snapshotNy, range[0], range[1]);
    expect(inNewYork.map((w) => w.startAt.toISOString())).toEqual(inShanghai.map((w) => w.startAt.toISOString()));
  });

  it("supports overnight periods attributed to their start weekday", () => {
    const snapshot = shanghai([
      { weekday: 5, startMinutes: 22 * 60, durationMinutes: 4 * 60, validFrom: null, validTo: null, note: null }
    ]);
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-04T00:00:00Z")
    );
    // 2026-05-01 是周五：本地周五 22:00 -> 周六 02:00
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startAt.toISOString()).toBe("2026-05-01T14:00:00.000Z");
    expect(windows[0]!.endAt.toISOString()).toBe("2026-05-01T18:00:00.000Z");
    expect(windows[0]!.localDate).toBe("2026-05-01");
    expect(windows[0]!.weekday).toBe(5);
  });

  it("removes a full-day closure and clips overnight spill from the previous day", () => {
    // 每日 22:00–次日 02:00；5 月 2 日全天闭馆
    const overnight = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday, startMinutes: 22 * 60, durationMinutes: 4 * 60, validFrom: null, validTo: null, note: null
    }));
    const snapshot = shanghai(overnight, [
      {
        id: "00000000-0000-0000-0000-000000000001",
        kind: "closed",
        localDate: "2026-05-02",
        endLocalDate: null,
        startMinutes: null,
        durationMinutes: null,
        reason: "设备检修"
      }
    ]);
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-04T00:00:00Z")
    );
    // 5/1 的窗口（本地 22:00–次日02:00）应在 5/2 00:00（=5/1 16:00Z）被截断
    const mayFirst = windows.find((w) => w.localDate === "2026-05-01");
    expect(mayFirst!.endAt.toISOString()).toBe("2026-05-01T16:00:00.000Z");
    expect(windows.some((w) => w.localDate === "2026-05-02")).toBe(false);
    // 5/3 恢复
    expect(windows.some((w) => w.localDate === "2026-05-03")).toBe(true);
  });

  it("cuts a timed closure out of weekly hours", () => {
    const snapshot = shanghai(dailyNineToSix, [
      {
        id: "00000000-0000-0000-0000-000000000002",
        kind: "closed",
        localDate: "2026-05-02",
        endLocalDate: null,
        startMinutes: 12 * 60,
        durationMinutes: 60,
        reason: "午间活动"
      }
    ]);
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-05-02T00:00:00Z"),
      new Date("2026-05-03T00:00:00Z")
    );
    // 09:00–12:00 与 13:00–18:00（UTC 01:00–04:00, 05:00–10:00）
    expect(windows.map((w) => [w.startAt.toISOString(), w.endAt.toISOString()])).toEqual([
      ["2026-05-02T01:00:00.000Z", "2026-05-02T04:00:00.000Z"],
      ["2026-05-02T05:00:00.000Z", "2026-05-02T10:00:00.000Z"]
    ]);
  });

  it("replaces weekly hours with a holiday open exception and suppresses overnight spill", () => {
    const overnight = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday, startMinutes: 22 * 60, durationMinutes: 4 * 60, validFrom: null, validTo: null, note: null
    }));
    const snapshot = shanghai(overnight, [
      {
        id: "00000000-0000-0000-0000-000000000003",
        kind: "open",
        localDate: "2026-05-02",
        endLocalDate: null,
        startMinutes: 10 * 60,
        durationMinutes: 2 * 60,
        reason: "节假日特别开放 10:00–12:00"
      }
    ]);
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-03T00:00:00Z")
    );
    // 5/1 夜场在 5/2 00:00 截断；5/2 仅有 10:00–12:00
    const mayFirst = windows.find((w) => w.localDate === "2026-05-01");
    expect(mayFirst!.endAt.toISOString()).toBe("2026-05-01T16:00:00.000Z");
    const holiday = windows.find((w) => w.localDate === "2026-05-02");
    expect(holiday!.startAt.toISOString()).toBe("2026-05-02T02:00:00.000Z");
    expect(holiday!.endAt.toISOString()).toBe("2026-05-02T04:00:00.000Z");
    expect(holiday!.source).toBe("exception_open");
  });

  it("clips next-day weekly hours when a timed closure runs overnight", () => {
    // 每日 00:00–02:00 与 09:00–18:00；5/1 23:00 起闭馆 3 小时（溢出到 5/2 02:00）
    const weekly = [
      ...[0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday, startMinutes: 0, durationMinutes: 120, validFrom: null, validTo: null, note: null
      })),
      ...[0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday, startMinutes: 9 * 60, durationMinutes: 9 * 60, validFrom: null, validTo: null, note: null
      }))
    ];
    const snapshot = shanghai(weekly, [
      {
        id: "00000000-0000-0000-0000-000000000006",
        kind: "closed",
        localDate: "2026-05-01",
        endLocalDate: null,
        startMinutes: 23 * 60,
        durationMinutes: 180,
        reason: "夜间活动"
      }
    ]);
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-05-01T16:00:00Z"),
      new Date("2026-05-02T12:00:00Z")
    );
    // 5/2 的 00:00–02:00 窗口（UTC 5/1 16:00–18:00）应被闭馆完全覆盖而消失；
    // 5/2 09:00–18:00（UTC 01:00–10:00）保留
    expect(windows.map((w) => [w.startAt.toISOString(), w.endAt.toISOString()])).toEqual([
      ["2026-05-02T01:00:00.000Z", "2026-05-02T10:00:00.000Z"]
    ]);
  });

  it("expands a multi-day closure over its full date range", () => {    const snapshot = shanghai(dailyNineToSix, [
      {
        id: "00000000-0000-0000-0000-000000000004",
        kind: "closed",
        localDate: "2026-05-02",
        endLocalDate: "2026-05-03",
        startMinutes: null,
        durationMinutes: null,
        reason: "连续闭馆"
      }
    ]);
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-05T00:00:00Z")
    );
    expect(windows.map((w) => w.localDate).sort()).toEqual(["2026-05-01", "2026-05-04"]);
  });

  it("respects weekday period validity windows", () => {
    const snapshot = shanghai([
      {
        weekday: 5,
        startMinutes: 9 * 60,
        durationMinutes: 60,
        validFrom: "2026-05-08",
        validTo: null,
        note: null
      }
    ]);
    const before = computeOpenWindows(snapshot, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-02T00:00:00Z"));
    expect(before).toHaveLength(0);
    const after = computeOpenWindows(snapshot, new Date("2026-05-08T00:00:00Z"), new Date("2026-05-09T00:00:00Z"));
    expect(after).toHaveLength(1);
  });

  it("computes correct windows across a New York DST spring-forward weekend", () => {
    const snapshot: ScheduleSnapshot = {
      timezone: "America/New_York",
      weekly: [
        // 周六 09:00–17:00（本地 8 小时）
        { weekday: 6, startMinutes: 9 * 60, durationMinutes: 8 * 60, validFrom: null, validTo: null, note: null }
      ],
      exceptions: []
    };
    // 2026-03-08 是夏令时跳变日（本地周日）；周六窗口落在 UTC 3/7
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-03-07T00:00:00Z"),
      new Date("2026-03-08T12:00:00Z")
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startAt.toISOString()).toBe("2026-03-07T14:00:00.000Z");
    expect(windows[0]!.endAt.toISOString()).toBe("2026-03-07T22:00:00.000Z");
    expect(windows[0]!.endAt.getTime() - windows[0]!.startAt.getTime()).toBe(8 * 3600_000);
  });

  it("keeps correct duration for an overnight window crossing the spring-forward gap", () => {
    const snapshot: ScheduleSnapshot = {
      timezone: "America/New_York",
      weekly: [
        // 周日 01:30–03:30：结束时刻 03:30 不存在（gap 为 02:00–03:00），
        // 按 forward 规则 03:30 在 gap 之后正常换算；02:00–03:00 这一小时不存在，窗口实际 1 小时
        { weekday: 0, startMinutes: 90, durationMinutes: 120, validFrom: null, validTo: null, note: null }
      ],
      exceptions: []
    };
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-03-08T00:00:00Z"),
      new Date("2026-03-09T00:00:00Z")
    );
    expect(windows).toHaveLength(1);
    // 01:30 EST = 06:30Z；03:30 EDT = 07:30Z；缺失的一小时令实际时长为 60 分钟
    expect(windows[0]!.startAt.toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(windows[0]!.endAt.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("clamps a window end that lands inside the spring-forward gap", () => {
    const snapshot: ScheduleSnapshot = {
      timezone: "America/New_York",
      weekly: [
        // 周日 01:30–02:30：结束时刻不存在，夹到跳变点 03:00 EDT = 07:00Z
        { weekday: 0, startMinutes: 90, durationMinutes: 60, validFrom: null, validTo: null, note: null }
      ],
      exceptions: []
    };
    const windows = computeOpenWindows(
      snapshot,
      new Date("2026-03-08T00:00:00Z"),
      new Date("2026-03-09T00:00:00Z")
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startAt.toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(windows[0]!.endAt.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });
});

describe("computeOpenStatus", () => {
  it("returns unknown when no schedule exists", () => {
    expect(computeOpenStatus(null, new Date("2026-05-01T05:00:00Z")).state).toBe("unknown");
  });

  it("reports open with closing time and closed with next opening time", () => {
    const snapshot = shanghai(dailyNineToSix);
    // 本地 12:00 = UTC 04:00
    const open = computeOpenStatus(snapshot, new Date("2026-05-01T04:00:00Z"));
    expect(open.state).toBe("open");
    expect(open.closesAt!.toISOString()).toBe("2026-05-01T10:00:00.000Z");

    // 本地 20:00 = UTC 12:00，已关门，次日 09:00 开
    const closed = computeOpenStatus(snapshot, new Date("2026-05-01T12:00:00Z"));
    expect(closed.state).toBe("closed");
    expect(closed.nextOpenAt!.toISOString()).toBe("2026-05-02T01:00:00.000Z");
  });

  it("reports closed all day on a full-day closure", () => {
    const snapshot = shanghai(dailyNineToSix, [
      {
        id: "00000000-0000-0000-0000-000000000005",
        kind: "closed",
        localDate: "2026-05-01",
        endLocalDate: null,
        startMinutes: null,
        durationMinutes: null,
        reason: "闭馆"
      }
    ]);
    const status = computeOpenStatus(snapshot, new Date("2026-05-01T04:00:00Z"));
    expect(status.state).toBe("closed");
    expect(status.nextOpenAt!.toISOString()).toBe("2026-05-02T01:00:00.000Z");
  });
});

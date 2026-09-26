import { describe, expect, it } from "vitest";
import {
  exceptionInputSchema,
  isValidTimeZone,
  timeToMinutes,
  weekdayPeriodInputSchema,
  weekdayPeriodReplaceSchema
} from "@map/shared/schedule";

describe("schedule input contracts", () => {
  it("accepts an overnight period when end <= start", () => {
    const parsed = weekdayPeriodInputSchema.parse({
      weekday: 5,
      startTime: "22:00",
      endTime: "02:00"
    });
    expect(timeToMinutes(parsed.endTime) - timeToMinutes(parsed.startTime)).toBeLessThan(0);
  });

  it("rejects malformed times and out-of-range weekdays", () => {
    expect(weekdayPeriodInputSchema.safeParse({ weekday: 7, startTime: "09:00", endTime: "18:00" }).success).toBe(false);
    expect(weekdayPeriodInputSchema.safeParse({ weekday: 1, startTime: "24:00", endTime: "18:00" }).success).toBe(false);
    expect(weekdayPeriodInputSchema.safeParse({ weekday: 1, startTime: "9am", endTime: "18:00" }).success).toBe(false);
  });

  it("allows a full-day closure without a time window", () => {
    const parsed = exceptionInputSchema.parse({
      kind: "closed",
      localDate: "2026-10-01",
      reason: "国庆闭馆"
    });
    expect(parsed.startTime).toBeUndefined();
  });

  it("requires a time window for open exceptions", () => {
    expect(exceptionInputSchema.safeParse({
      kind: "open",
      localDate: "2026-10-01",
      reason: "特别开放"
    }).success).toBe(false);
    expect(exceptionInputSchema.safeParse({
      kind: "open",
      localDate: "2026-10-01",
      startTime: "10:00",
      endTime: "12:00",
      reason: "特别开放"
    }).success).toBe(true);
  });

  it("rejects reversed date ranges and overly long weekly lists", () => {
    expect(exceptionInputSchema.safeParse({
      kind: "closed",
      localDate: "2026-10-05",
      endLocalDate: "2026-10-01",
      reason: "区间反向"
    }).success).toBe(false);
    const tooMany = { periods: Array.from({ length: 50 }, () => ({
      weekday: 1, startTime: "09:00", endTime: "18:00"
    })) };
    expect(weekdayPeriodReplaceSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe("timezone validation", () => {
  it("accepts canonical IANA zones and rejects arbitrary strings", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Fake_City")).toBe(false);
    expect(isValidTimeZone("GMT+8")).toBe(false);
  });
});

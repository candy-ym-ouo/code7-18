import {
  computeOpeningWindows,
  localDateInZone,
  type OpeningExceptionInput,
  type WeekPattern
} from "@map/shared/opening-hours";
import { pool } from "./db";

const ROLL_BATCH_SIZE = 100;

/**
 * 滚动延展开放时段的物化窗口地平线。
 *
 * 窗口是（时区、周期时段、例外、地平线）的确定性函数：地平线滚动只会
 * 在远端追加新窗口，不会改变既有窗口，因此这里不做订阅通知——
 * 定义变更触发的复算与通知由 API 事务同步完成。
 */
export async function rollOpeningWindows(): Promise<void> {
  const stale = await pool.query<{ id: string }>(
    `SELECT id FROM opening_schedules
     WHERE windows_generated_until IS NULL
        OR windows_generated_until < now() + interval '30 days'
     ORDER BY updated_at ASC
     LIMIT $1`,
    [ROLL_BATCH_SIZE]
  );

  for (const row of stale.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const scheduleResult = await client.query<{
        id: string;
        timezone: string;
        week_pattern: WeekPattern;
      }>(
        "SELECT id, timezone, week_pattern FROM opening_schedules WHERE id = $1 FOR UPDATE",
        [row.id]
      );
      const schedule = scheduleResult.rows[0];
      if (!schedule) {
        await client.query("ROLLBACK");
        continue;
      }
      const exceptions = await client.query<{
        kind: "temporary_closure" | "holiday";
        starts_on: string;
        ends_on: string;
        override_periods: OpeningExceptionInput["overridePeriods"] | null;
      }>(
        `SELECT kind, starts_on::text, ends_on::text, override_periods
         FROM opening_exceptions WHERE schedule_id = $1 ORDER BY starts_on`,
        [schedule.id]
      );

      const now = new Date();
      const windows = computeOpeningWindows({
        timezone: schedule.timezone,
        weekPattern: schedule.week_pattern,
        exceptions: exceptions.rows.map((exception) => ({
          kind: exception.kind,
          startsOn: exception.starts_on,
          endsOn: exception.ends_on,
          overridePeriods: exception.override_periods ?? null
        })),
        horizonStart: localDateInZone(now, schedule.timezone)
      });

      await client.query("DELETE FROM opening_windows WHERE schedule_id = $1", [schedule.id]);
      for (const window of windows) {
        await client.query(
          "INSERT INTO opening_windows(schedule_id, open_at, close_at, source) VALUES ($1, $2, $3, $4)",
          [schedule.id, window.openAt.toISOString(), window.closeAt.toISOString(), window.source]
        );
      }
      const horizonEnd = windows.length ? windows[windows.length - 1]!.closeAt : now;
      await client.query(
        "UPDATE opening_schedules SET windows_generated_until = $2, updated_at = now() WHERE id = $1",
        [schedule.id, horizonEnd.toISOString()]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error({ error, scheduleId: row.id }, "opening windows roll failed");
    } finally {
      client.release();
    }
  }
}

import type { PoolClient } from "pg";
import {
  computeOpeningWindows,
  localDateInZone,
  windowsEqual,
  type OpeningExceptionInput,
  type OpeningWindow,
  type WeekPattern
} from "@map/shared/opening-hours";
import { recordAudit } from "./audit";
import { notifyUser } from "./notifications";

type ScheduleRow = {
  id: string;
  feature_id: string;
  timezone: string;
  week_pattern: WeekPattern;
};

type ExceptionRow = {
  kind: "temporary_closure" | "holiday";
  starts_on: string;
  ends_on: string;
  override_periods: OpeningExceptionInput["overridePeriods"] | null;
};

function toDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

async function loadStoredWindows(client: PoolClient, scheduleId: string): Promise<OpeningWindow[]> {
  const result = await client.query<{ open_at: Date; close_at: Date; source: "weekly" | "exception" }>(
    `SELECT open_at, close_at, source FROM opening_windows
     WHERE schedule_id = $1 AND close_at > now() ORDER BY open_at`,
    [scheduleId]
  );
  return result.rows.map((row) => ({ openAt: row.open_at, closeAt: row.close_at, source: row.source }));
}

/**
 * 在调用方事务内复算一个开放时段计划的物化窗口。
 * 复算是确定性的：相同（时区、周期时段、例外、地平线）永远产生相同窗口，
 * 因此可以安全地整体删除重建。返回未来窗口是否发生变化。
 */
export async function recomputeScheduleWindows(
  client: PoolClient,
  scheduleId: string
): Promise<{ changed: boolean; windowCount: number }> {
  const scheduleResult = await client.query<ScheduleRow>(
    "SELECT id, feature_id, timezone, week_pattern FROM opening_schedules WHERE id = $1 FOR UPDATE",
    [scheduleId]
  );
  const schedule = scheduleResult.rows[0];
  if (!schedule) throw new Error(`Opening schedule not found: ${scheduleId}`);

  const exceptions = await client.query<ExceptionRow>(
    `SELECT kind, starts_on::text, ends_on::text, override_periods
     FROM opening_exceptions WHERE schedule_id = $1 ORDER BY starts_on`,
    [scheduleId]
  );

  const now = new Date();
  const fresh = computeOpeningWindows({
    timezone: schedule.timezone,
    weekPattern: schedule.week_pattern,
    exceptions: exceptions.rows.map((row) => ({
      kind: row.kind,
      startsOn: toDate(row.starts_on),
      endsOn: toDate(row.ends_on),
      overridePeriods: row.override_periods ?? null
    })),
    horizonStart: localDateInZone(now, schedule.timezone)
  });

  const stored = await loadStoredWindows(client, scheduleId);
  const freshFuture = fresh.filter((window) => window.closeAt.getTime() > now.getTime());
  const changed = !windowsEqual(stored, freshFuture);

  await client.query("DELETE FROM opening_windows WHERE schedule_id = $1", [scheduleId]);
  for (const window of fresh) {
    await client.query(
      `INSERT INTO opening_windows(schedule_id, open_at, close_at, source) VALUES ($1, $2, $3, $4)`,
      [scheduleId, window.openAt.toISOString(), window.closeAt.toISOString(), window.source]
    );
  }
  const horizonEnd = fresh.length ? fresh[fresh.length - 1]!.closeAt : now;
  await client.query(
    "UPDATE opening_schedules SET windows_generated_until = $2, updated_at = now() WHERE id = $1",
    [scheduleId, horizonEnd.toISOString()]
  );
  return { changed, windowCount: fresh.length };
}

/**
 * 开放时段定义变更后的统一收尾：复算窗口、写审计，
 * 未来窗口发生变化时通知全部订阅者（以及非操作者本人的地点作者）。
 */
export async function applyOpeningScheduleChange(
  client: PoolClient,
  input: {
    scheduleId: string;
    featureId: string;
    actorId: string;
    action: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ changed: boolean }> {
  const { changed, windowCount } = await recomputeScheduleWindows(client, input.scheduleId);
  await recordAudit(client, {
    actorId: input.actorId,
    action: input.action,
    resourceType: "opening_schedule",
    resourceId: input.scheduleId,
    metadata: { ...input.metadata, featureId: input.featureId, windowsChanged: changed, windowCount }
  });
  if (changed) await notifyOpeningSubscribers(client, input.featureId, input.actorId);
  return { changed };
}

async function notifyOpeningSubscribers(client: PoolClient, featureId: string, actorId: string): Promise<void> {
  const [feature, subscribers] = await Promise.all([
    client.query<{ owner_id: string; title: string | null }>(
      `SELECT mf.owner_id, revision.payload->>'title' AS title
       FROM map_features mf
       LEFT JOIN LATERAL (
         SELECT payload FROM feature_revisions WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
       ) revision ON true
       WHERE mf.id = $1`,
      [featureId]
    ),
    client.query<{ user_id: string }>(
      "SELECT user_id FROM opening_subscriptions WHERE feature_id = $1",
      [featureId]
    )
  ]);
  const ownerId = feature.rows[0]?.owner_id;
  const title = feature.rows[0]?.title ?? "未命名地点";
  const recipients = new Set(subscribers.rows.map((row) => row.user_id));
  if (ownerId) recipients.add(ownerId);
  recipients.delete(actorId);

  for (const userId of recipients) {
    await notifyUser(client, {
      userId,
      type: "opening_hours_changed",
      title: "你关注的地点开放时段已更新",
      body: `地点「${title}」的开放时段发生变更，最新安排以地点页为准。`,
      link: `/features/${featureId}`
    });
  }
}

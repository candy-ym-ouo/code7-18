import { config } from "./config";
import { pool, withTransaction } from "./db";
import {
  minutesToTime,
  wallTimeToUtcMs
} from "@map/shared/schedule";

type ChangedPayload = {
  featureId: string;
  version: number;
  changedBy: string;
  timezone: string;
  upcomingClosures: Array<{
    id: string;
    localDate: string;
    endLocalDate: string | null;
    allDay: boolean;
    startTime: string | null;
    reason: string;
  }>;
};

type Subscriber = { user_id: string; email: string };

async function getFeatureInfo(featureId: string): Promise<{ title: string } | null> {
  const result = await pool.query<{ title: string }>(
    `SELECT fr.payload->>'title' AS title
     FROM map_features mf
     JOIN feature_revisions fr ON fr.id = mf.current_revision_id
     WHERE mf.id = $1 AND mf.deleted_at IS NULL`,
    [featureId]
  );
  return result.rows[0] ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * 在单个事务中写入“去重记录 + 站内通知 + 邮件 outbox”。
 * 若去重键已存在（之前发送过），事务不产生任何新内容并返回 false。
 */
async function deliverOnce(input: {
  featureId: string;
  notificationType: "schedule_changed" | "closure_reminder";
  dedupeKey: string;
  title: string;
  body: string;
  link: string;
  subscriber: Subscriber;
}): Promise<boolean> {
  const { featureId, notificationType, dedupeKey, title, body, link, subscriber } = input;
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO schedule_notification_log(feature_id, user_id, notification_type, dedupe_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [featureId, subscriber.user_id, notificationType, dedupeKey]
    );
    if (!inserted.rowCount) return false;

    await client.query(
      `INSERT INTO notifications(user_id, type, title, body, link)
       VALUES ($1, $2, $3, $4, $5)`,
      [subscriber.user_id, notificationType, title, body, link]
    );

    const url = `${config.APP_ORIGIN}${link}`;
    await client.query(
      `INSERT INTO outbox_events(kind, event_type, aggregate_type, aggregate_id, payload)
       VALUES ('email', 'email.notification', 'user', $1, $2::jsonb)`,
      [subscriber.user_id, JSON.stringify({
        to: subscriber.email,
        subject: title,
        text: `${body}\n\n${url}`,
        html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
      })]
    );
    return true;
  });
}

/**
 * 规则变更后通知所有订阅者（变更者本人除外）。
 * 每个订阅者的去重记录、站内通知与邮件 outbox 在同一事务内提交；
 * (user_id, dedupe_key) 唯一约束保证同一 outbox 事件重试不会产生重复通知或邮件。
 */
export async function fanOutScheduleChange(eventId: string, payload: ChangedPayload): Promise<void> {
  const feature = await getFeatureInfo(payload.featureId);
  if (!feature) return;

  const subscribers = await pool.query<Subscriber>(
    `SELECT ss.user_id, u.email
     FROM schedule_subscriptions ss
     JOIN users u ON u.id = ss.user_id
     WHERE ss.feature_id = $1 AND ss.user_id <> $2 AND u.deleted_at IS NULL`,
    [payload.featureId, payload.changedBy]
  );

  const title = `「${feature.title}」开放时段有变更`;
  const body = buildChangeBody(payload);
  const link = `/features/${payload.featureId}`;

  for (const subscriber of subscribers.rows) {
    await deliverOnce({
      featureId: payload.featureId,
      notificationType: "schedule_changed",
      dedupeKey: `change:${eventId}`,
      title,
      body,
      link,
      subscriber
    });
  }
}

function buildChangeBody(payload: ChangedPayload): string {
  const closures = payload.upcomingClosures;
  if (!closures.length) return `周期时段已更新（版本 ${payload.version}），请查看最新开放安排。`;
  const first = closures[0]!;
  const range = first.endLocalDate && first.endLocalDate !== first.localDate
    ? `${first.localDate} 至 ${first.endLocalDate}`
    : first.localDate;
  const when = first.allDay ? `${range} 全天` : `${range} ${first.startTime ?? ""} 起`;
  const more = closures.length > 1 ? ` 等 ${closures.length} 项安排` : "";
  return `开放时段已更新（版本 ${payload.version}）。近期闭馆：${when}，原因：${first.reason}${more}。`;
}

/**
 * 维护任务：找出将在 24–48 小时后开始的闭馆，向订阅者发送“即将闭馆”提醒。
 * 幂等：dedupe_key 以 exception id 为键，每个用户每条闭馆只提醒一次。
 */
export async function sendClosureReminders(now = new Date()): Promise<number> {
  // 粗筛：UTC 日期落在前 1 天到后 4 天（覆盖任意时区偏差与 24–48 小时窗口）
  const result = await pool.query<{
    exception_id: string;
    feature_id: string;
    title: string;
    timezone: string;
    local_date: string;
    end_local_date: string | null;
    start_minutes: number | null;
    reason: string;
  }>(
    `SELECT se.id AS exception_id, se.feature_id, fr.payload->>'title' AS title,
            ps.timezone,
            to_char(se.local_date, 'YYYY-MM-DD') AS local_date,
            to_char(se.end_local_date, 'YYYY-MM-DD') AS end_local_date,
            se.start_minutes, se.reason
     FROM schedule_exceptions se
     JOIN place_schedules ps ON ps.feature_id = se.feature_id
     JOIN map_features mf ON mf.id = se.feature_id AND mf.deleted_at IS NULL AND mf.status = 'published'
     JOIN feature_revisions fr ON fr.id = mf.current_revision_id
     WHERE se.kind = 'closed'
       AND se.local_date BETWEEN (now() AT TIME ZONE 'UTC')::date - 1
                             AND (now() AT TIME ZONE 'UTC')::date + 4`
  );

  let sent = 0;
  for (const closure of result.rows) {
    const startUtcMs = wallTimeToUtcMs(closure.timezone, closure.local_date, closure.start_minutes ?? 0);
    const hoursUntil = (startUtcMs - now.getTime()) / 3_600_000;
    // 24–48 小时窗口；worker 每分钟巡检，重复落入窗口时由唯一约束去重
    if (hoursUntil < 24 || hoursUntil > 48) continue;

    sent += await notifyClosure(closure);
  }
  return sent;
}

async function notifyClosure(closure: {
  exception_id: string;
  feature_id: string;
  title: string;
  local_date: string;
  end_local_date: string | null;
  start_minutes: number | null;
  reason: string;
}): Promise<number> {
  const subscribers = await pool.query<Subscriber>(
    `SELECT ss.user_id, u.email
     FROM schedule_subscriptions ss
     JOIN users u ON u.id = ss.user_id
     WHERE ss.feature_id = $1 AND u.deleted_at IS NULL`,
    [closure.feature_id]
  );

  const range = closure.end_local_date && closure.end_local_date !== closure.local_date
    ? `${closure.local_date} 至 ${closure.end_local_date}`
    : closure.local_date;
  const when = closure.start_minutes === null ? `${range} 全天` : `${range} ${minutesToTime(closure.start_minutes)} 起`;
  const title = `「${closure.title}」即将闭馆提醒`;
  const body = `该地点将于 ${when} 闭馆。原因：${closure.reason}。`;
  const link = `/features/${closure.feature_id}`;

  let count = 0;
  for (const subscriber of subscribers.rows) {
    const delivered = await deliverOnce({
      featureId: closure.feature_id,
      notificationType: "closure_reminder",
      dedupeKey: `closure:${closure.exception_id}`,
      title,
      body,
      link,
      subscriber
    });
    if (delivered) count += 1;
  }
  return count;
}

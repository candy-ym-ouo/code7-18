import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  WEEKDAY_LABELS,
  computeOpenStatus,
  computeOpenWindows,
  exceptionInputSchema,
  isValidTimeZone,
  minutesToTime,
  scheduleSettingsSchema,
  timeToMinutes,
  weekdayPeriodReplaceSchema,
  type ExceptionInput,
  type ScheduleSnapshot,
  type WeekdayPeriodInput
} from "@map/shared/schedule";
import { query, transaction } from "../db";
import { AppError, forbidden, notFound } from "../errors";
import { optionalAuth, requireAuth } from "../auth";
import { recordAudit, queueOutbox } from "../audit";
import { enqueueOutbox } from "../queue";
import { createVersion, loadSnapshot } from "../schedule-service";

const MAX_RANGE_DAYS = 60;

async function assertFeature(client: Parameters<Parameters<typeof transaction>[0]>[0], featureId: string) {
  const result = await client.query<{ status: string; owner_id: string }>(
    "SELECT status, owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL",
    [featureId]
  );
  const row = result.rows[0];
  if (!row) throw notFound("Feature not found");
  return row;
}

async function assertPublishedFeature(client: Parameters<Parameters<typeof transaction>[0]>[0], featureId: string) {
  const row = await assertFeature(client, featureId);
  if (row.status !== "published") throw notFound("Published feature not found");
  return row;
}

async function assertCanManage(featureId: string, userId: string, role: string) {
  const result = await query<{ owner_id: string }>(
    "SELECT owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL",
    [featureId]
  );
  const row = result.rows[0];
  if (!row) throw notFound("Feature not found");
  const canManage = row.owner_id === userId || role === "moderator" || role === "admin";
  if (!canManage) throw forbidden("只有地点作者或管理员可以维护开放时段");
}

function durationFromTimes(startTime: string, endTime: string): number {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  return end > start ? end - start : 1440 - start + end;
}

function serializeSettings(timezone: string, version: number) {
  return { timezone, version };
}

function serializePeriod(row: {
  id: string; weekday: number; start_minutes: number; duration_minutes: number;
  valid_from: string | null; valid_to: string | null; note: string | null;
}) {
  const start = row.start_minutes;
  return {
    id: row.id,
    weekday: row.weekday,
    weekdayLabel: WEEKDAY_LABELS[row.weekday] ?? "",
    startTime: minutesToTime(start),
    endTime: minutesToTime(start + row.duration_minutes),
    overnight: start + row.duration_minutes >= 1440,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    note: row.note
  };
}

function serializeException(row: {
  id: string; kind: "closed" | "open"; local_date: string; end_local_date: string | null;
  start_minutes: number | null; duration_minutes: number | null; reason: string;
}) {
  const allDay = row.kind === "closed" && row.start_minutes === null;
  return {
    id: row.id,
    kind: row.kind,
    localDate: row.local_date,
    endLocalDate: row.end_local_date,
    allDay,
    startTime: row.start_minutes === null ? null : minutesToTime(row.start_minutes),
    endTime: row.start_minutes === null || row.duration_minutes === null
      ? null
      : minutesToTime(row.start_minutes + row.duration_minutes),
    reason: row.reason
  };
}

async function getScheduleRows(featureId: string) {
  const result = await query<{ status: string; timezone: string | null; version: number | null; updated_at: Date | null }>(
    `SELECT mf.status, ps.timezone, ps.version, ps.updated_at
     FROM map_features mf
     LEFT JOIN place_schedules ps ON ps.feature_id = mf.id
     WHERE mf.id = $1 AND mf.deleted_at IS NULL`,
    [featureId]
  );
  return result.rows[0] ?? null;
}

export async function scheduleRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // 公开查询
  // -------------------------------------------------------------------------

  app.get("/features/:id/schedule", { preHandler: optionalAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await getScheduleRows(params.id);
    if (!row) throw notFound("Feature not found");
    // 非发布地点仅作者/审核员可见其时段草稿
    if (row.status !== "published") {
      if (!request.user) throw notFound("Published feature not found");
      const feature = await query<{ owner_id: string }>(
        "SELECT owner_id FROM map_features WHERE id = $1",
        [params.id]
      );
      const ownerId = feature.rows[0]?.owner_id;
      const canInspect = ownerId === request.user.id || ["moderator", "admin"].includes(request.user.role);
      if (!canInspect) throw notFound("Published feature not found");
    }

    const [periods, exceptions] = await Promise.all([
      query<{
        id: string; weekday: number; start_minutes: number; duration_minutes: number;
        valid_from: string | null; valid_to: string | null; note: string | null;
      }>(
        `SELECT id, weekday, start_minutes, duration_minutes,
                to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
                to_char(valid_to, 'YYYY-MM-DD') AS valid_to, note
         FROM schedule_weekday_periods WHERE feature_id = $1
         ORDER BY weekday, start_minutes, sort_order`,
        [params.id]
      ),
      query<{
        id: string; kind: "closed" | "open"; local_date: string; end_local_date: string | null;
        start_minutes: number | null; duration_minutes: number | null; reason: string;
      }>(
        `SELECT id, kind, to_char(local_date, 'YYYY-MM-DD') AS local_date,
                to_char(end_local_date, 'YYYY-MM-DD') AS end_local_date,
                start_minutes, duration_minutes, reason
         FROM schedule_exceptions WHERE feature_id = $1
         ORDER BY local_date, created_at`,
        [params.id]
      )
    ]);

    let subscribed = false;
    if (request.user) {
      const sub = await query(
        "SELECT 1 FROM schedule_subscriptions WHERE feature_id = $1 AND user_id = $2",
        [params.id, request.user.id]
      );
      subscribed = sub.rowCount !== null && sub.rowCount > 0;
    }

    return {
      timezone: row.timezone ?? null,
      version: row.version ?? null,
      updatedAt: row.updated_at ?? null,
      weekly: periods.rows.map(serializePeriod),
      exceptions: exceptions.rows.map(serializeException),
      subscribed
    };
  });

  app.get("/features/:id/schedule/status", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const queryInput = z.object({
      at: z.string().datetime().optional()
    }).parse(request.query);

    const snapshot = await transaction(async (client) => {
      const feature = await client.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [params.id]
      );
      if (!feature.rows[0] || feature.rows[0].status !== "published") {
        throw notFound("Published feature not found");
      }
      return loadSnapshot(client, params.id);
    });

    const at = queryInput.at ? new Date(queryInput.at) : new Date();
    const status = computeOpenStatus(snapshot, at);
    return {
      at: at.toISOString(),
      timezone: snapshot?.timezone ?? null,
      state: status.state,
      closesAt: status.closesAt?.toISOString() ?? null,
      nextOpenAt: status.nextOpenAt?.toISOString() ?? null
    };
  });

  app.get("/features/:id/schedule/windows", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      from: z.string().datetime(),
      to: z.string().datetime()
    }).parse(request.query);

    const from = new Date(input.from);
    const to = new Date(input.to);
    if (to <= from) throw new AppError(400, "VALIDATION_FAILED", "to 必须晚于 from");
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    if (days > MAX_RANGE_DAYS) throw new AppError(400, "VALIDATION_FAILED", `时间跨度不能超过 ${MAX_RANGE_DAYS} 天`);

    const snapshot = await transaction(async (client) => {
      const feature = await client.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [params.id]
      );
      if (!feature.rows[0] || feature.rows[0].status !== "published") {
        throw notFound("Published feature not found");
      }
      return loadSnapshot(client, params.id);
    });

    if (!snapshot) {
      return { timezone: null, windows: [] };
    }
    const windows = computeOpenWindows(snapshot, from, to);
    return {
      timezone: snapshot.timezone,
      windows: windows.map((window) => ({
        startAt: window.startAt.toISOString(),
        endAt: window.endAt.toISOString(),
        localDate: window.localDate,
        weekday: window.weekday,
        source: window.source
      }))
    };
  });

  // -------------------------------------------------------------------------
  // 规则管理（作者 / 审核员 / 管理员）
  // -------------------------------------------------------------------------

  app.put("/features/:id/schedule/settings", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = scheduleSettingsSchema.parse(request.body);
    if (!isValidTimeZone(input.timezone)) {
      throw new AppError(400, "VALIDATION_FAILED", "无效的 IANA 时区，例如 Asia/Shanghai");
    }
    await assertCanManage(params.id, request.user!.id, request.user!.role);

    const result = await transaction(async (client) => {
      const feature = await assertFeature(client, params.id);
      const previous = await client.query<{ timezone: string }>(
        "SELECT timezone FROM place_schedules WHERE feature_id = $1",
        [params.id]
      );
      const created = await createVersion(client, {
        featureId: params.id,
        changedBy: request.user!.id,
        changeType: "settings.updated",
        timezone: input.timezone,
        summary: { from: previous.rows[0]?.timezone ?? null, to: input.timezone }
      });
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "schedule.settings_updated",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { version: created.version, timezone: input.timezone, ownerId: feature.owner_id }
      });
      return enqueueScheduleEvents(client, params.id, created.version, created.snapshot, request.user!.id);
    });
    await enqueueOutbox(result.outboxId);
    return { status: "ok", ...serializeSettings(input.timezone, result.version) };
  });

  app.put("/features/:id/schedule/weekly", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = weekdayPeriodReplaceSchema.parse(request.body);
    await assertCanManage(params.id, request.user!.id, request.user!.role);

    const result = await transaction(async (client) => {
      await assertFeature(client, params.id);
      await ensureTimezone(client, params.id);
      await client.query("DELETE FROM schedule_weekday_periods WHERE feature_id = $1", [params.id]);
      for (const [index, period] of input.periods.entries()) {
        await insertWeeklyPeriod(client, params.id, period, index);
      }
      const created = await createVersion(client, {
        featureId: params.id,
        changedBy: request.user!.id,
        changeType: "weekly.replaced",
        summary: { count: input.periods.length }
      });
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "schedule.weekly_replaced",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { version: created.version, count: input.periods.length }
      });
      return enqueueScheduleEvents(client, params.id, created.version, created.snapshot, request.user!.id);
    });
    await enqueueOutbox(result.outboxId);
    return { status: "ok", version: result.version };
  });

  app.post("/features/:id/schedule/exceptions", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = exceptionInputSchema.parse(request.body) as ExceptionInput;
    await assertCanManage(params.id, request.user!.id, request.user!.role);

    const result = await transaction(async (client) => {
      await assertFeature(client, params.id);
      await ensureTimezone(client, params.id);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO schedule_exceptions(
           feature_id, kind, local_date, end_local_date, start_minutes, duration_minutes, reason, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          params.id,
          input.kind,
          input.localDate,
          input.endLocalDate ?? null,
          input.kind === "closed" && input.startTime == null ? null : timeToMinutes(input.startTime!),
          input.kind === "closed" && input.startTime == null
            ? null
            : durationFromTimes(input.startTime!, input.endTime!),
          input.reason,
          request.user!.id
        ]
      );
      const exceptionId = inserted.rows[0]!.id;
      const created = await createVersion(client, {
        featureId: params.id,
        changedBy: request.user!.id,
        changeType: "exception.created",
        summary: { exceptionId, kind: input.kind, localDate: input.localDate }
      });
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "schedule.exception_created",
        resourceType: "schedule_exception",
        resourceId: exceptionId,
        metadata: { featureId: params.id, version: created.version, kind: input.kind }
      });
      return { ...await enqueueScheduleEvents(client, params.id, created.version, created.snapshot, request.user!.id), exceptionId };
    });
    await enqueueOutbox(result.outboxId);
    return reply.code(201).send({ id: result.exceptionId, status: "created", version: result.version });
  });

  app.delete("/features/:id/schedule/exceptions/:exceptionId", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid(), exceptionId: z.string().uuid() }).parse(request.params);
    await assertCanManage(params.id, request.user!.id, request.user!.role);

    const result = await transaction(async (client) => {
      await assertFeature(client, params.id);
      const deleted = await client.query(
        "DELETE FROM schedule_exceptions WHERE id = $1 AND feature_id = $2 RETURNING id, kind, local_date",
        [params.exceptionId, params.id]
      );
      if (!deleted.rowCount) throw notFound("Exception not found");
      const created = await createVersion(client, {
        featureId: params.id,
        changedBy: request.user!.id,
        changeType: "exception.deleted",
        summary: { exceptionId: params.exceptionId, ...deleted.rows[0] }
      });
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "schedule.exception_deleted",
        resourceType: "schedule_exception",
        resourceId: params.exceptionId,
        metadata: { featureId: params.id, version: created.version }
      });
      return enqueueScheduleEvents(client, params.id, created.version, created.snapshot, request.user!.id);
    });
    await enqueueOutbox(result.outboxId);
    return { status: "deleted", version: result.version };
  });

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------

  app.put("/features/:id/schedule/subscription", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const feature = await client.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [params.id]
      );
      if (!feature.rows[0] || feature.rows[0].status !== "published") {
        throw notFound("Published feature not found");
      }
      await client.query(
        `INSERT INTO schedule_subscriptions(feature_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [params.id, request.user!.id]
      );
    });
    return { subscribed: true };
  });

  app.delete("/features/:id/schedule/subscription", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await query("DELETE FROM schedule_subscriptions WHERE feature_id = $1 AND user_id = $2",
      [params.id, request.user!.id]);
    return { subscribed: false };
  });
}

async function ensureTimezone(
  client: Parameters<Parameters<typeof transaction>[0]>[0],
  featureId: string
): Promise<void> {
  const result = await client.query("SELECT 1 FROM place_schedules WHERE feature_id = $1", [featureId]);
  if (!result.rowCount) {
    throw new AppError(409, "SCHEDULE_TIMEZONE_REQUIRED", "请先设置地点时区，再维护开放时段");
  }
}

async function insertWeeklyPeriod(
  client: Parameters<Parameters<typeof transaction>[0]>[0],
  featureId: string,
  period: WeekdayPeriodInput,
  index: number
): Promise<void> {
  await client.query(
    `INSERT INTO schedule_weekday_periods(
       feature_id, weekday, start_minutes, duration_minutes, valid_from, valid_to, note, sort_order
     ) VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8)`,
    [
      featureId,
      period.weekday,
      timeToMinutes(period.startTime),
      durationFromTimes(period.startTime, period.endTime),
      period.validFrom ?? null,
      period.validTo ?? null,
      period.note ?? null,
      index
    ]
  );
}

/**
 * 规则已写入并生成新版本后：
 * - 发出 schedule.changed 领域事件（worker 负责扇出订阅者的站内通知 + 邮件）；
 * - 同时为受影响的闭馆生成“即将闭馆提醒”事件（worker 幂等发送）。
 */
async function enqueueScheduleEvents(
  client: Parameters<Parameters<typeof transaction>[0]>[0],
  featureId: string,
  version: number,
  snapshot: ScheduleSnapshot,
  changedBy: string
): Promise<{ outboxId: string; version: number }> {
  const upcomingClosures = snapshot.exceptions
    .filter((exception) => exception.kind === "closed")
    .map((exception) => ({
      id: exception.id,
      localDate: exception.localDate,
      endLocalDate: exception.endLocalDate,
      allDay: exception.startMinutes === null,
      startTime: exception.startMinutes === null ? null : minutesToTime(exception.startMinutes),
      reason: exception.reason
    }));

  const outboxId = await queueOutbox(client, {
    kind: "schedule_changed",
    eventType: "schedule.changed",
    aggregateType: "feature",
    aggregateId: featureId,
    payload: {
      featureId,
      version,
      changedBy,
      timezone: snapshot.timezone,
      upcomingClosures
    }
  });
  return { outboxId, version };
}

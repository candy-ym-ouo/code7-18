import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  openingExceptionSchema,
  upsertOpeningScheduleSchema,
  type OpeningWindow,
  type WeekPattern
} from "@map/shared/opening-hours";
import { query, transaction } from "../db";
import { AppError, conflict, forbidden, notFound } from "../errors";
import { optionalAuth, requireAuth, requireVerifiedContributor, type AuthUser } from "../auth";
import { applyOpeningScheduleChange } from "../opening-hours";

const OPENING_WINDOWS_MAX_RANGE_DAYS = 31;

type FeatureAccessRow = { owner_id: string; status: string };

function canManage(user: AuthUser, ownerId: string): boolean {
  return user.id === ownerId || user.role === "moderator" || user.role === "admin";
}

async function loadFeatureForRead(request: FastifyRequest, featureId: string): Promise<FeatureAccessRow> {
  const result = await query<FeatureAccessRow>(
    "SELECT owner_id, status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
    [featureId]
  );
  const feature = result.rows[0];
  if (!feature) throw notFound("Feature not found");
  const canInspectPrivate = request.user && canManage(request.user, feature.owner_id);
  if (feature.status !== "published" && !canInspectPrivate) throw notFound("Feature not found");
  return feature;
}

function serializeWindow(row: { open_at: Date; close_at: Date; source: string }) {
  return {
    openAt: row.open_at.toISOString(),
    closeAt: row.close_at.toISOString(),
    source: row.source as OpeningWindow["source"]
  };
}

export async function openingHoursRoutes(app: FastifyInstance) {
  app.get("/features/:id/opening-hours", { preHandler: optionalAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await loadFeatureForRead(request, params.id);

    const scheduleResult = await query<{
      id: string;
      timezone: string;
      week_pattern: WeekPattern;
      version: number;
      windows_generated_until: Date | null;
      updated_at: Date;
    }>(
      `SELECT id, timezone, week_pattern, version, windows_generated_until, updated_at
       FROM opening_schedules WHERE feature_id = $1`,
      [params.id]
    );
    const schedule = scheduleResult.rows[0];
    if (!schedule) return { schedule: null, exceptions: [], subscribed: false };

    const [exceptions, subscription] = await Promise.all([
      query<{
        id: string;
        kind: string;
        starts_on: string;
        ends_on: string;
        override_periods: unknown;
        reason: string | null;
      }>(
        `SELECT id, kind, starts_on::text, ends_on::text, override_periods, reason
         FROM opening_exceptions WHERE schedule_id = $1 ORDER BY starts_on, created_at`,
        [schedule.id]
      ),
      request.user
        ? query("SELECT 1 FROM opening_subscriptions WHERE feature_id = $1 AND user_id = $2", [params.id, request.user.id])
        : Promise.resolve(null)
    ]);

    return {
      schedule: {
        id: schedule.id,
        timezone: schedule.timezone,
        weekPattern: schedule.week_pattern,
        version: schedule.version,
        windowsGeneratedUntil: schedule.windows_generated_until,
        updatedAt: schedule.updated_at
      },
      exceptions: exceptions.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        overridePeriods: row.override_periods,
        reason: row.reason
      })),
      subscribed: Boolean(subscription?.rowCount)
    };
  });

  app.put("/features/:id/opening-hours", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = upsertOpeningScheduleSchema.parse(request.body);
    const userId = request.user!.id;

    const result = await transaction(async (client) => {
      const featureResult = await client.query<FeatureAccessRow>(
        "SELECT owner_id, status FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const feature = featureResult.rows[0];
      if (!feature) throw notFound("Feature not found");
      if (!canManage(request.user!, feature.owner_id)) throw forbidden();

      const upserted = await client.query<{ id: string }>(
        `INSERT INTO opening_schedules(feature_id, timezone, week_pattern, created_by, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, $4)
         ON CONFLICT (feature_id) DO UPDATE SET
           timezone = EXCLUDED.timezone,
           week_pattern = EXCLUDED.week_pattern,
           version = opening_schedules.version + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING id`,
        [params.id, input.timezone, JSON.stringify(input.weekPattern), userId]
      );
      const scheduleId = upserted.rows[0]!.id;
      return applyOpeningScheduleChange(client, {
        scheduleId,
        featureId: params.id,
        actorId: userId,
        action: "opening_hours.schedule_upserted",
        metadata: { timezone: input.timezone }
      });
    });

    return { status: "updated", windowsChanged: result.changed };
  });

  app.post("/features/:id/opening-hours/exceptions", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = openingExceptionSchema.parse(request.body);
    const userId = request.user!.id;

    const created = await transaction(async (client) => {
      const featureResult = await client.query<FeatureAccessRow>(
        "SELECT owner_id, status FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const feature = featureResult.rows[0];
      if (!feature) throw notFound("Feature not found");
      if (!canManage(request.user!, feature.owner_id)) throw forbidden();

      const schedule = await client.query<{ id: string }>(
        "SELECT id FROM opening_schedules WHERE feature_id = $1 FOR UPDATE",
        [params.id]
      );
      const scheduleId = schedule.rows[0]?.id;
      if (!scheduleId) throw conflict("Create the recurring opening schedule before adding exceptions");

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO opening_exceptions(schedule_id, kind, starts_on, ends_on, override_periods, reason, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         RETURNING id`,
        [
          scheduleId,
          input.kind,
          input.startsOn,
          input.endsOn,
          input.overridePeriods?.length ? JSON.stringify(input.overridePeriods) : null,
          input.reason ?? null,
          userId
        ]
      );
      const { changed } = await applyOpeningScheduleChange(client, {
        scheduleId,
        featureId: params.id,
        actorId: userId,
        action: "opening_hours.exception_added",
        metadata: { exceptionId: inserted.rows[0]!.id, kind: input.kind, startsOn: input.startsOn, endsOn: input.endsOn }
      });
      return { id: inserted.rows[0]!.id, changed };
    });

    return reply.code(201).send({ id: created.id, status: "created", windowsChanged: created.changed });
  });

  app.delete("/features/:id/opening-hours/exceptions/:exceptionId", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid(), exceptionId: z.string().uuid() }).parse(request.params);
    const userId = request.user!.id;

    const changed = await transaction(async (client) => {
      const featureResult = await client.query<FeatureAccessRow>(
        "SELECT owner_id, status FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const feature = featureResult.rows[0];
      if (!feature) throw notFound("Feature not found");
      if (!canManage(request.user!, feature.owner_id)) throw forbidden();

      const deleted = await client.query<{ schedule_id: string }>(
        `DELETE FROM opening_exceptions oe
         USING opening_schedules os
         WHERE oe.id = $1 AND oe.schedule_id = os.id AND os.feature_id = $2
         RETURNING oe.schedule_id`,
        [params.exceptionId, params.id]
      );
      const scheduleId = deleted.rows[0]?.schedule_id;
      if (!scheduleId) throw notFound("Exception not found");
      const result = await applyOpeningScheduleChange(client, {
        scheduleId,
        featureId: params.id,
        actorId: userId,
        action: "opening_hours.exception_deleted",
        metadata: { exceptionId: params.exceptionId }
      });
      return result.changed;
    });

    return { status: "deleted", windowsChanged: changed };
  });

  app.get("/features/:id/opening-hours/status", { preHandler: optionalAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ at: z.coerce.date().optional() }).parse(request.query);
    await loadFeatureForRead(request, params.id);
    const at = input.at ?? new Date();

    const schedule = await query<{ id: string; timezone: string }>(
      "SELECT id, timezone FROM opening_schedules WHERE feature_id = $1",
      [params.id]
    );
    const row = schedule.rows[0];
    if (!row) {
      return { timezone: null, at: at.toISOString(), isOpen: null, currentWindow: null, nextWindow: null };
    }

    const [current, next] = await Promise.all([
      query<{ open_at: Date; close_at: Date; source: string }>(
        `SELECT open_at, close_at, source FROM opening_windows
         WHERE schedule_id = $1 AND open_at <= $2 AND close_at > $2
         ORDER BY open_at DESC LIMIT 1`,
        [row.id, at]
      ),
      query<{ open_at: Date; close_at: Date; source: string }>(
        `SELECT open_at, close_at, source FROM opening_windows
         WHERE schedule_id = $1 AND open_at > $2
         ORDER BY open_at ASC LIMIT 1`,
        [row.id, at]
      )
    ]);

    return {
      timezone: row.timezone,
      at: at.toISOString(),
      isOpen: Boolean(current.rowCount && current.rowCount > 0),
      currentWindow: current.rows[0] ? serializeWindow(current.rows[0]) : null,
      nextWindow: next.rows[0] ? serializeWindow(next.rows[0]) : null
    };
  });

  app.get("/features/:id/opening-hours/windows", { preHandler: optionalAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ from: z.coerce.date(), to: z.coerce.date() }).parse(request.query);
    await loadFeatureForRead(request, params.id);

    if (input.to.getTime() <= input.from.getTime()) {
      throw new AppError(400, "VALIDATION_FAILED", "to must be after from");
    }
    const maxRangeMs = OPENING_WINDOWS_MAX_RANGE_DAYS * 24 * 3600_000;
    if (input.to.getTime() - input.from.getTime() > maxRangeMs) {
      throw new AppError(400, "VALIDATION_FAILED", `Window range is limited to ${OPENING_WINDOWS_MAX_RANGE_DAYS} days`);
    }

    const schedule = await query<{ id: string; timezone: string }>(
      "SELECT id, timezone FROM opening_schedules WHERE feature_id = $1",
      [params.id]
    );
    const row = schedule.rows[0];
    if (!row) return { timezone: null, from: input.from.toISOString(), to: input.to.toISOString(), windows: [] };

    const windows = await query<{ open_at: Date; close_at: Date; source: string }>(
      `SELECT open_at, close_at, source FROM opening_windows
       WHERE schedule_id = $1 AND close_at > $2 AND open_at < $3
       ORDER BY open_at`,
      [row.id, input.from, input.to]
    );
    return {
      timezone: row.timezone,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      windows: windows.rows.map(serializeWindow)
    };
  });

  app.put("/features/:id/opening-subscription", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const feature = await query<{ status: string }>(
      "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
      [params.id]
    );
    if (feature.rows[0]?.status !== "published") throw notFound("Published feature not found");
    await query(
      `INSERT INTO opening_subscriptions(feature_id, user_id) VALUES ($1, $2)
       ON CONFLICT (feature_id, user_id) DO NOTHING`,
      [params.id, request.user!.id]
    );
    return { status: "subscribed" };
  });

  app.delete("/features/:id/opening-subscription", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await query(
      "DELETE FROM opening_subscriptions WHERE feature_id = $1 AND user_id = $2",
      [params.id, request.user!.id]
    );
    return { status: "unsubscribed" };
  });

  app.get("/me/opening-subscriptions", { preHandler: requireAuth }, async (request) => {
    const result = await query<{
      feature_id: string;
      created_at: Date;
      title: string | null;
      category_key: string;
    }>(
      `SELECT os.feature_id, os.created_at, mf.category_key,
              revision.payload->>'title' AS title
       FROM opening_subscriptions os
       JOIN map_features mf ON mf.id = os.feature_id AND mf.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT payload FROM feature_revisions WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
       ) revision ON true
       WHERE os.user_id = $1
       ORDER BY os.created_at DESC`,
      [request.user!.id]
    );
    return result.rows.map((row) => ({
      featureId: row.feature_id,
      title: row.title,
      categoryKey: row.category_key,
      subscribedAt: row.created_at
    }));
  });
}

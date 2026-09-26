import type { PoolClient } from "pg";
import type { ScheduleSnapshot } from "@map/shared/schedule";

export type SnapshotRow = {
  timezone: string;
  weekly: Array<{
    id: string;
    weekday: number;
    start_minutes: number;
    duration_minutes: number;
    valid_from: string | null;
    valid_to: string | null;
    note: string | null;
  }>;
  exceptions: Array<{
    id: string;
    kind: "closed" | "open";
    local_date: string;
    end_local_date: string | null;
    start_minutes: number | null;
    duration_minutes: number | null;
    reason: string;
    created_at: string;
  }>;
};

/** 读取地点的当前规则快照；没有 place_schedules 行时返回 null（对外表现为 unknown）。 */
export async function loadSnapshot(
  client: PoolClient,
  featureId: string
): Promise<ScheduleSnapshot | null> {
  const settings = await client.query<{ timezone: string }>(
    "SELECT timezone FROM place_schedules WHERE feature_id = $1",
    [featureId]
  );
  const row = settings.rows[0];
  if (!row) return null;

  const [weekly, exceptions] = await Promise.all([
    client.query<SnapshotRow["weekly"][number]>(
      `SELECT id, weekday, start_minutes, duration_minutes,
              to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
              to_char(valid_to, 'YYYY-MM-DD') AS valid_to,
              note
       FROM schedule_weekday_periods
       WHERE feature_id = $1
       ORDER BY weekday, start_minutes, sort_order, created_at`,
      [featureId]
    ),
    client.query<SnapshotRow["exceptions"][number]>(
      `SELECT id, kind,
              to_char(local_date, 'YYYY-MM-DD') AS local_date,
              to_char(end_local_date, 'YYYY-MM-DD') AS end_local_date,
              start_minutes, duration_minutes, reason,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM schedule_exceptions
       WHERE feature_id = $1
       ORDER BY local_date, created_at`,
      [featureId]
    )
  ]);

  return {
    timezone: row.timezone,
    weekly: weekly.rows.map((period) => ({
      id: period.id,
      weekday: period.weekday,
      startMinutes: period.start_minutes,
      durationMinutes: period.duration_minutes,
      validFrom: period.valid_from,
      validTo: period.valid_to,
      note: period.note
    })),
    exceptions: exceptions.rows.map((exception) => ({
      id: exception.id,
      kind: exception.kind,
      localDate: exception.local_date,
      endLocalDate: exception.end_local_date,
      startMinutes: exception.start_minutes,
      durationMinutes: exception.duration_minutes,
      reason: exception.reason,
      createdAt: exception.created_at
    }))
  };
}

/**
 * 在已开启的事务中创建不可变版本快照并入队复算。
 * 返回新版本号与快照。调用方负责先完成规则写入；
 * 若传 timezone，则在同一 upsert 中更新时区（保证快照读取到新值）。
 */
export async function createVersion(
  client: PoolClient,
  input: {
    featureId: string;
    changedBy: string;
    changeType: string;
    summary?: Record<string, unknown>;
    timezone?: string;
  }
): Promise<{ version: number; snapshot: ScheduleSnapshot }> {
  const bumped = await client.query<{ version: number }>(
    `INSERT INTO place_schedules(feature_id, timezone, created_by, version)
     VALUES ($1, COALESCE($3, 'Asia/Shanghai'), $2, 1)
     ON CONFLICT (feature_id) DO UPDATE
       SET version = place_schedules.version + 1,
           timezone = COALESCE($3, place_schedules.timezone),
           updated_at = now()
     RETURNING version`,
    [input.featureId, input.changedBy, input.timezone ?? null]
  );
  const version = bumped.rows[0]!.version;
  const snapshot = await loadSnapshot(client, input.featureId);
  if (!snapshot) throw new Error("schedule snapshot unavailable after upsert");

  await client.query(
    `INSERT INTO schedule_versions(feature_id, version, changed_by, change_type, change_summary, snapshot)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      input.featureId,
      version,
      input.changedBy,
      input.changeType,
      JSON.stringify(input.summary ?? {}),
      JSON.stringify(snapshot)
    ]
  );

  return { version, snapshot };
}

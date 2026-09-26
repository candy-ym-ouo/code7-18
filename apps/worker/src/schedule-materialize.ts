import { pool, withTransaction } from "./db";
import { computeOpenWindows, type ScheduleSnapshot } from "@map/shared/schedule";

// 向前保留 2 天窗口（覆盖查询边界），向后预生成 180 天
const PAST_HORIZON_DAYS = 2;
const FUTURE_HORIZON_DAYS = 180;
// 单版本最多写入的窗口数，防止规则错误导致无限膨胀
const MAX_WINDOWS_PER_VERSION = 5_000;

type VersionRow = {
  id: string;
  feature_id: string;
  version: number;
  snapshot: ScheduleSnapshot;
};

/**
 * 把待处理版本的规则快照复算为 UTC 开放窗口。
 * 同一地点的旧未来窗口先删除再写入；排他约束保证任何时刻窗口不重叠。
 * 幂等：重复执行同一版本只会重建一次（状态为 pending 时才认领）。
 */
export async function materializePendingVersions(limit = 10): Promise<number> {
  const claimed = await pool.query<VersionRow>(
    `UPDATE schedule_versions
     SET status = 'processing'
     WHERE id IN (
       SELECT id FROM schedule_versions
       WHERE status = 'pending'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, feature_id, version, snapshot`,
    [limit]
  );

  let processed = 0;
  for (const row of claimed.rows) {
    try {
      const windowCount = await withTransaction(async (client) => {
        // 删除该地点未来（含少量过去缓冲）的窗口
        await client.query(
          `DELETE FROM schedule_opening_windows
           WHERE feature_id = $1 AND end_at > now() - ($2 || ' days')::interval`,
          [row.feature_id, String(PAST_HORIZON_DAYS)]
        );

        const now = new Date();
        const from = new Date(now.getTime() - PAST_HORIZON_DAYS * 86_400_000);
        const to = new Date(now.getTime() + FUTURE_HORIZON_DAYS * 86_400_000);
        const windows = computeOpenWindows(row.snapshot, from, to).slice(0, MAX_WINDOWS_PER_VERSION);

        for (const window of windows) {
          await client.query(
            `INSERT INTO schedule_opening_windows(feature_id, start_at, end_at, version_id, source_kind)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (feature_id, start_at) DO NOTHING`,
            [row.feature_id, window.startAt, window.endAt, row.id, window.source]
          );
        }

        await client.query(
          `UPDATE schedule_versions
           SET status = 'materialized', materialized_at = now(), last_error = NULL
           WHERE id = $1`,
          [row.id]
        );
        return windows.length;
      });
      processed += 1;
      console.log(`schedule ${row.feature_id} v${row.version} materialized ${windowCount} windows`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown materialization error";
      await pool.query(
        `UPDATE schedule_versions SET status = 'failed', last_error = $2 WHERE id = $1`,
        [row.id, message]
      );
      console.error({ versionId: row.id, error }, "schedule materialization failed");
    }
  }
  return processed;
}

/** 卡住（worker 崩溃）的 processing 版本回到 pending 重新复算。 */
export async function recoverStuckScheduleVersions(): Promise<void> {
  await pool.query(
    `UPDATE schedule_versions
     SET status = 'pending', last_error = 'Recovered after worker timeout'
     WHERE status = 'processing' AND created_at < now() - interval '10 minutes'`
  );
}

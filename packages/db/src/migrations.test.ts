import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../migrations/0001_init.sql"),
  "utf8"
);

describe("initial migration", () => {
  it("contains the core audited entities", () => {
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "comments", "reports",
      "moderation_actions", "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds public thumbnail and outbox recovery fields in migration 0002", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0002_media_public_thumb.sql"),
      "utf8"
    );
    expect(followup).toContain("public_thumbnail_object_key");
    expect(followup).toContain("updated_at timestamptz");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });

  it("adds opening hours entities in migration 0003", () => {
    const opening = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_opening_hours.sql"),
      "utf8"
    );
    for (const table of [
      "opening_schedules", "opening_exceptions", "opening_windows", "opening_subscriptions"
    ]) {
      expect(opening).toContain(`CREATE TABLE ${table}`);
    }
    expect(opening).toContain("CREATE TYPE opening_exception_kind AS ENUM ('temporary_closure', 'holiday')");
    // 每个地点至多一条周期计划；物化窗口以 UTC timestamptz 存储保证跨时区一致
    expect(opening).toContain("feature_id uuid NOT NULL UNIQUE REFERENCES map_features(id)");
    expect(opening).toContain("open_at timestamptz NOT NULL");
    expect(opening).toContain("close_at timestamptz NOT NULL");
  });
});

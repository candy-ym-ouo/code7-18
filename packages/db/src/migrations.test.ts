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

  it("creates the schedule module tables, versioning and exclusion constraint in migration 0003", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_place_schedules.sql"),
      "utf8"
    );
    for (const table of [
      "place_schedules",
      "schedule_weekday_periods",
      "schedule_exceptions",
      "schedule_versions",
      "schedule_opening_windows",
      "schedule_subscriptions",
      "schedule_notification_log"
    ]) {
      expect(followup).toContain(`CREATE TABLE ${table}`);
    }
    expect(followup).toContain("btree_gist");
    expect(followup).toContain("EXCLUDE USING gist");
    expect(followup).toContain("schedule_exception_kind");
    expect(followup).toContain("ADD COLUMN kind text NOT NULL DEFAULT 'email'");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });
});

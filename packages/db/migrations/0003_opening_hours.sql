CREATE TYPE opening_exception_kind AS ENUM ('temporary_closure', 'holiday');

CREATE TABLE opening_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL UNIQUE REFERENCES map_features(id) ON DELETE CASCADE,
  timezone text NOT NULL,
  week_pattern jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  windows_generated_until timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE opening_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES opening_schedules(id) ON DELETE CASCADE,
  kind opening_exception_kind NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  override_periods jsonb,
  reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX opening_exceptions_schedule_idx ON opening_exceptions(schedule_id, starts_on);

CREATE TABLE opening_windows (
  schedule_id uuid NOT NULL REFERENCES opening_schedules(id) ON DELETE CASCADE,
  open_at timestamptz NOT NULL,
  close_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('weekly', 'exception')),
  PRIMARY KEY (schedule_id, open_at),
  CHECK (close_at > open_at)
);
CREATE INDEX opening_windows_range_idx ON opening_windows(schedule_id, close_at, open_at);

CREATE TABLE opening_subscriptions (
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_id, user_id)
);
CREATE INDEX opening_subscriptions_user_idx ON opening_subscriptions(user_id, created_at DESC);

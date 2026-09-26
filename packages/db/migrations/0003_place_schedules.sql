-- 地点开放时段模块：周期时段、临时闭馆、节假日例外、可复算窗口与订阅提醒

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 每个地点一行开放时段设置；没有该行表示地点尚未维护时段（查询结果为 unknown）
CREATE TYPE schedule_exception_kind AS ENUM ('closed', 'open');

CREATE TABLE place_schedules (
  feature_id uuid PRIMARY KEY REFERENCES map_features(id) ON DELETE CASCADE,
  -- IANA 时区名，由应用层用 Intl 校验；规则中的时间均按此时区解释
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 每周重复的周期时段。end_time <= start_time 表示跨夜（营业到次日）
CREATE TABLE schedule_weekday_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=周日 … 6=周六
  start_minutes integer NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1439),
  valid_from date,
  valid_to date,
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_weekday_periods_feature_idx
  ON schedule_weekday_periods(feature_id, weekday, valid_from, valid_to);

-- 单日或区间例外：closed=临时闭馆（含节假日闭馆），open=节假日特别开放
CREATE TABLE schedule_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  kind schedule_exception_kind NOT NULL,
  local_date date NOT NULL,
  end_local_date date,
  -- 全天闭馆（kind=closed）时为 NULL；open 例外必填
  start_minutes integer CHECK (start_minutes IS NULL OR start_minutes BETWEEN 0 AND 1439),
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 15 AND 1439),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_exceptions_range_check CHECK (
    end_local_date IS NULL OR end_local_date >= local_date
  ),
  CONSTRAINT schedule_exceptions_period_check CHECK (
    (kind = 'open' AND start_minutes IS NOT NULL AND duration_minutes IS NOT NULL)
    OR (kind = 'closed')
  )
);
CREATE INDEX schedule_exceptions_feature_idx
  ON schedule_exceptions(feature_id, local_date, end_local_date);

-- 规则变更的不可变快照；worker 按快照幂等重建未来窗口
CREATE TABLE schedule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  version integer NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  change_type text NOT NULL,
  change_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'materialized', 'failed')),
  materialized_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_id, version)
);
CREATE INDEX schedule_versions_queue_idx ON schedule_versions(status, created_at) WHERE status = 'pending';

-- 复算产物：UTC 半开区间 [start_at, end_at)，排他约束保证同一地点区间不重叠
CREATE TABLE schedule_opening_windows (
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  version_id uuid NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  PRIMARY KEY (feature_id, start_at),
  CONSTRAINT schedule_opening_windows_range_check CHECK (end_at > start_at),
  CONSTRAINT schedule_opening_windows_no_overlap
    EXCLUDE USING gist (
      feature_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
);
CREATE INDEX schedule_opening_windows_time_idx
  ON schedule_opening_windows(start_at, end_at);

-- 订阅地点时段变化
CREATE TABLE schedule_subscriptions (
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_id, user_id)
);
CREATE INDEX schedule_subscriptions_user_idx ON schedule_subscriptions(user_id, created_at DESC);

-- 通知幂等记录（变更通知与闭馆提醒共用）
CREATE TABLE schedule_notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX schedule_notification_log_feature_idx
  ON schedule_notification_log(feature_id, notification_type, created_at DESC);

-- outbox 增加事件类别，默认 email 保持与既有事件兼容
ALTER TABLE outbox_events ADD COLUMN kind text NOT NULL DEFAULT 'email';
CREATE INDEX IF NOT EXISTS outbox_events_kind_queue_idx
  ON outbox_events(kind, status, available_at);

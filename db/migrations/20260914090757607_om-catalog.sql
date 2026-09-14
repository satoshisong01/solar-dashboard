-- Up Migration
-- 카탈로그: 사이트 → 설비 트리, 메트릭 정의, 게이트웨이·키, 포인트 매핑 (설계 §5.2).
-- 메트릭·설비 종류 추가는 스키마 변경 없이 INSERT로 한다.

CREATE TABLE om.site (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lon double precision CHECK (lon BETWEEN -180 AND 180),
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  attributes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE om.asset_class (
  key text PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('system', 'asset', 'component')),
  parent_key text REFERENCES om.asset_class (key),
  name_ko text NOT NULL,
  nameplate_schema jsonb NOT NULL DEFAULT '{}', -- 명판 필드 JSON Schema
  safety_event_codes text[] NOT NULL DEFAULT '{}' -- 수신 즉시 안전 레인으로 보낼 이벤트 코드
);

CREATE TABLE om.asset (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES om.site (id),
  parent_id integer REFERENCES om.asset (id),
  level text NOT NULL CHECK (level IN ('system', 'asset', 'component')),
  class_key text NOT NULL REFERENCES om.asset_class (key),
  code text NOT NULL, -- 사이트 안 경로 (예: ELZ1/STACK1)
  path text NOT NULL, -- 사이트 코드 포함 경로 (예: SIM-B/ELZ1/STACK1)
  name text NOT NULL,
  nameplate jsonb NOT NULL DEFAULT '{}',
  peer_group text,
  criticality smallint NOT NULL DEFAULT 3 CHECK (criticality BETWEEN 1 AND 5),
  commissioned_at date,
  UNIQUE (site_id, code)
);
CREATE INDEX asset_parent_id_idx ON om.asset (parent_id);
CREATE INDEX asset_class_key_idx ON om.asset (class_key);

-- 교체·펌웨어·설정값 변경·정비. resets_baseline이면 분석 기준선을 이 시점에서 나눈다.
CREATE TABLE om.asset_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id integer NOT NULL REFERENCES om.asset (id),
  ts timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('replacement', 'firmware', 'setpoint_change', 'maintenance', 'calibration', 'other')),
  resets_baseline boolean NOT NULL DEFAULT false,
  note text,
  created_by text
);
CREATE INDEX asset_event_asset_ts_idx ON om.asset_event (asset_id, ts);

CREATE TABLE om.metric_def (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*$'), -- domain.quantity[.qualifier]
  quantity text NOT NULL,
  unit text NOT NULL, -- 정규 단위. 수집값은 point.scale/value_offset으로 이 단위로 바꾼다
  value_kind text NOT NULL CHECK (value_kind IN ('gauge', 'counter', 'state', 'bool')),
  rollup text NOT NULL CHECK (rollup IN ('avg', 'sum', 'last', 'max', 'min', 'delta')),
  hard_min double precision, -- 물리적으로 불가능한 범위 (HARD_RANGE 비트)
  hard_max double precision,
  expected_min double precision, -- 정상 운전의 전형 범위
  expected_max double precision,
  flatline_max_s integer CHECK (flatline_max_s > 0), -- 값이 이 시간 넘게 그대로면 고착 의심
  name_ko text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]', -- 벤더 태그·표준 모델 이름 (매핑 제안용)
  CHECK (hard_min IS NULL OR hard_max IS NULL OR hard_min < hard_max),
  CHECK (expected_min IS NULL OR expected_max IS NULL OR expected_min <= expected_max)
);

CREATE TABLE om.gateway (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES om.site (id),
  code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_seen_at timestamptz,
  last_seq bigint,
  clock_offset_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gateway_site_id_idx ON om.gateway (site_id);

-- secret_enc: AES-256-GCM 암호문 (키는 env INGEST_KEY_ENC_KEY, 형식은 lib/ingest/key-crypto.ts)
CREATE TABLE om.gateway_key (
  key_id text PRIMARY KEY,
  gateway_id smallint NOT NULL REFERENCES om.gateway (id),
  secret_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX gateway_key_gateway_id_idx ON om.gateway_key (gateway_id) WHERE revoked_at IS NULL;

-- 키 회전을 위해 게이트웨이당 활성 키는 최대 2개. 게이트웨이 행을 잠가 동시 추가도 막는다.
CREATE FUNCTION om.gateway_key_limit_active() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active integer;
BEGIN
  PERFORM 1 FROM om.gateway WHERE id = NEW.gateway_id FOR UPDATE;
  SELECT count(*) INTO v_active
  FROM om.gateway_key
  WHERE gateway_id = NEW.gateway_id AND revoked_at IS NULL AND key_id <> NEW.key_id;
  IF v_active >= 2 THEN
    RAISE EXCEPTION '게이트웨이(id=%)의 활성 키는 최대 2개입니다. 기존 키를 먼저 폐기하세요.', NEW.gateway_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_key_limit_active
BEFORE INSERT OR UPDATE OF gateway_id, revoked_at ON om.gateway_key
FOR EACH ROW WHEN (NEW.revoked_at IS NULL)
EXECUTE FUNCTION om.gateway_key_limit_active();

-- (asset, metric, qualifier) ↔ (gateway, source_key). 정규값 = 원본값 × scale + value_offset
CREATE TABLE om.point (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id integer NOT NULL REFERENCES om.asset (id),
  metric_key text NOT NULL REFERENCES om.metric_def (key),
  qualifier text NOT NULL DEFAULT '',
  gateway_id smallint NOT NULL REFERENCES om.gateway (id),
  source_key text NOT NULL,
  source_unit text,
  scale double precision NOT NULL DEFAULT 1,
  value_offset double precision NOT NULL DEFAULT 0,
  period_s integer CHECK (period_s > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, metric_key, qualifier),
  UNIQUE (gateway_id, source_key)
);
CREATE INDEX point_metric_key_idx ON om.point (metric_key);

-- Down Migration
DROP TABLE IF EXISTS om.point;
DROP TABLE IF EXISTS om.gateway_key; -- 트리거도 함께 삭제된다
DROP FUNCTION IF EXISTS om.gateway_key_limit_active();
DROP TABLE IF EXISTS om.gateway;
DROP TABLE IF EXISTS om.metric_def;
DROP TABLE IF EXISTS om.asset_event;
DROP TABLE IF EXISTS om.asset;
DROP TABLE IF EXISTS om.asset_class;
DROP TABLE IF EXISTS om.site;

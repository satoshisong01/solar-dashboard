-- Up Migration
-- 수집: 원본 배치(bronze), 미매핑 태그, 원시 측정값(silver), 이산 이벤트 (설계 §5.1, §5.2).
-- 원시 측정값은 영구 보관한다. 파티션을 지우는 보존 함수·잡은 두지 않는다 (설계 §0).

-- 모르는 태그도 거부하지 않고 쌓는다. 나중에 point를 매핑하고 원본 배치를 재처리한다.
CREATE TABLE om.unmapped_source (
  gateway_id smallint NOT NULL REFERENCES om.gateway (id),
  source_key text NOT NULL,
  unit text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  sample_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (gateway_id, source_key)
);

-- 원본 gzip 본문을 그대로 보존한다 (재처리 원천). 보존 삭제 없음.
CREATE TABLE om.ingest_batch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway_id smallint NOT NULL REFERENCES om.gateway (id),
  batch_id uuid NOT NULL,
  seq bigint,
  sent_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  skew_ms integer,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  body_gzip bytea NOT NULL,
  n_samples integer NOT NULL DEFAULT 0,
  n_accepted integer NOT NULL DEFAULT 0,
  n_duplicate integer NOT NULL DEFAULT 0,
  n_rejected integer NOT NULL DEFAULT 0,
  n_unmapped integer NOT NULL DEFAULT 0,
  n_events integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('normalized', 'partial', 'failed')),
  UNIQUE (gateway_id, batch_id)
);
CREATE INDEX ingest_batch_received_at_brin ON om.ingest_batch USING brin (received_at);

-- 원시 측정값. UTC 월 파티션 + DEFAULT.
-- 대용량 테이블이라 point FK는 두지 않는다 (수집 코드가 매핑된 point_id만 넣는다).
-- quality 비트 (lib/ingest/quality.ts와 일치):
--   1 DEVICE_BAD, 2 HARD_RANGE, 4 SPIKE, 8 FLATLINE, 16 CLOCK_SUSPECT, 32 LATE, 64 REPROCESSED
CREATE TABLE om.measurement (
  point_id integer NOT NULL,
  ts timestamptz NOT NULL,
  value double precision, -- NULL = 결측 (0과 구분)
  quality smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (point_id, ts)
) PARTITION BY RANGE (ts);

-- 부모에 만든 인덱스는 기존·신규 파티션마다 같은 설정으로 생성된다.
CREATE INDEX measurement_ts_brin ON om.measurement
  USING brin (ts timestamptz_minmax_multi_ops) WITH (pages_per_range = 64, autosummarize = on);

CREATE TABLE om.measurement_default PARTITION OF om.measurement DEFAULT;

-- 범위 파티션 하나를 만든다. 이미 있으면 false.
-- DEFAULT 파티션에 그 범위의 행이 먼저 들어와 있으면 새 파티션으로 옮긴 뒤 붙인다
-- (그대로 CREATE TABLE ... PARTITION OF 하면 DEFAULT 제약 위반으로 실패한다).
CREATE FUNCTION om.create_range_partition(
  p_parent text, p_default text, p_child text, p_key text, p_from timestamptz, p_to timestamptz
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass(format('om.%I', p_child)) IS NOT NULL THEN
    RETURN false;
  END IF;

  EXECUTE format('CREATE TABLE om.%I (LIKE om.%I INCLUDING DEFAULTS)', p_child, p_parent);
  EXECUTE format(
    'WITH moved AS (DELETE FROM om.%I WHERE %I >= $1 AND %I < $2 RETURNING *) INSERT INTO om.%I SELECT * FROM moved',
    p_default, p_key, p_key, p_child
  ) USING p_from, p_to;
  EXECUTE format(
    'ALTER TABLE om.%I ATTACH PARTITION om.%I FOR VALUES FROM (%L) TO (%L)',
    p_parent, p_child, p_from, p_to
  );
  RETURN true;
END;
$$;

-- p_from이 속한 UTC 월부터 p_months개월치 파티션(measurement_yYYYYmMM)을 만든다. 만든 개수를 돌려준다.
CREATE FUNCTION om.ensure_measurement_partitions(p_from date, p_months integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_month timestamp;
  v_created integer := 0;
BEGIN
  IF p_months IS NULL OR p_months < 1 THEN
    RAISE EXCEPTION 'p_months는 1 이상이어야 합니다: %', p_months;
  END IF;

  FOR i IN 0 .. p_months - 1 LOOP
    v_month := date_trunc('month', p_from::timestamp) + make_interval(months => i);
    IF om.create_range_partition(
      'measurement', 'measurement_default', 'measurement_' || to_char(v_month, '"y"YYYY"m"MM'), 'ts',
      v_month AT TIME ZONE 'UTC', (v_month + interval '1 month') AT TIME ZONE 'UTC'
    ) THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;
  RETURN v_created;
END;
$$;

-- 현재 기준 -3개월 ~ +3개월 (7개월)
SELECT om.ensure_measurement_partitions(((now() AT TIME ZONE 'UTC') - interval '3 months')::date, 7);

-- 이산 이벤트·고장코드. 안전 이벤트(is_safety)는 분석 파이프라인을 거치지 않고 수집 트랜잭션에서 바로 기록한다.
CREATE TABLE om.event_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES om.site (id),
  asset_id integer REFERENCES om.asset (id),
  gateway_id smallint NOT NULL REFERENCES om.gateway (id),
  ts timestamptz NOT NULL,
  source_key text NOT NULL,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'minor', 'major', 'critical')),
  is_safety boolean NOT NULL DEFAULT false,
  text text,
  acked_by text,
  acked_at timestamptz,
  ack_note text,
  CHECK ((acked_by IS NULL) = (acked_at IS NULL)),
  UNIQUE (gateway_id, source_key, ts, code)
);
CREATE INDEX event_log_ts_brin ON om.event_log USING brin (ts);

-- Down Migration
DROP TABLE IF EXISTS om.event_log;
DROP FUNCTION IF EXISTS om.ensure_measurement_partitions(date, integer);
DROP FUNCTION IF EXISTS om.create_range_partition(text, text, text, text, timestamptz, timestamptz);
DROP TABLE IF EXISTS om.measurement; -- 파티션도 함께 삭제된다
DROP TABLE IF EXISTS om.ingest_batch;
DROP TABLE IF EXISTS om.unmapped_source;

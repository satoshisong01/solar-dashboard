-- Up Migration
-- 파생: 시간 롤업 대기열과 1시간 롤업, 수익 위젯 입력 (설계 §5.2).

-- 실제로 삽입된 (point, 시간 버킷)만 표시한다. 늦게 도착한 샘플은 gen을 올려 재계산 대상으로 만든다.
CREATE TABLE om.rollup_dirty (
  point_id integer NOT NULL,
  bucket timestamptz NOT NULL,
  gen bigint NOT NULL DEFAULT 1,
  touched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (point_id, bucket)
);

-- 1시간 롤업. 영구 보관, UTC 연 파티션 + DEFAULT. 대용량이라 point FK는 두지 않는다.
CREATE TABLE om.m_1h (
  point_id integer NOT NULL,
  bucket timestamptz NOT NULL,
  n integer NOT NULL,
  n_good integer NOT NULL,
  v_min double precision,
  v_max double precision,
  v_avg double precision,
  v_first double precision,
  v_last double precision,
  v_sum double precision,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (point_id, bucket)
) PARTITION BY RANGE (bucket);

CREATE TABLE om.m_1h_default PARTITION OF om.m_1h DEFAULT;

-- p_from이 속한 UTC 연도부터 p_years년치 파티션(m_1h_yYYYY)을 만든다. 만든 개수를 돌려준다.
CREATE FUNCTION om.ensure_m1h_partitions(p_from date, p_years integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_year timestamp;
  v_created integer := 0;
BEGIN
  IF p_years IS NULL OR p_years < 1 THEN
    RAISE EXCEPTION 'p_years는 1 이상이어야 합니다: %', p_years;
  END IF;

  FOR i IN 0 .. p_years - 1 LOOP
    v_year := date_trunc('year', p_from::timestamp) + make_interval(years => i);
    IF om.create_range_partition(
      'm_1h', 'm_1h_default', 'm_1h_' || to_char(v_year, '"y"YYYY'), 'bucket',
      v_year AT TIME ZONE 'UTC', (v_year + interval '1 year') AT TIME ZONE 'UTC'
    ) THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;
  RETURN v_created;
END;
$$;

-- 작년·올해·내년 (measurement 사전 생성 범위 -3개월 ~ +3개월을 덮는다)
SELECT om.ensure_m1h_partitions(((now() AT TIME ZONE 'UTC') - interval '1 year')::date, 3);

-- SMP·REC 일별 값 (수기 입력·CSV 업로드)
CREATE TABLE om.market_daily (
  day date NOT NULL,
  market_key text NOT NULL CHECK (market_key IN ('smp_land', 'smp_jeju', 'rec_avg')),
  value numeric NOT NULL,
  unit text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'csv')),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, market_key)
);

-- Down Migration
DROP TABLE IF EXISTS om.market_daily;
DROP FUNCTION IF EXISTS om.ensure_m1h_partitions(date, integer);
DROP TABLE IF EXISTS om.m_1h; -- 파티션도 함께 삭제된다
DROP TABLE IF EXISTS om.rollup_dirty;

-- Up Migration
-- 시뮬레이터 평가 스키마 sim (설계 §5.2 시뮬레이터 행, §5.5): 주입 고장 정답과 탐지기 스코어카드(sim:eval, /sim).
-- 로컬·테스트 DB 전용이다. 콘솔·수집 등 앱 코드는 sim을 참조하지 않으므로 운영 RDS에는 없어도 동작한다.
-- om 마이그레이션과 섞이지 않게 파일을 따로 두었다. node-pg-migrate는 적용 순서를 검사하므로 운영에 적용할 때도
-- 이 파일만 건너뛰지 말고 함께 적용한다 (빈 테이블 3개만 생기고 운영 데이터와는 연결되지 않는다).
CREATE SCHEMA IF NOT EXISTS sim;

-- 시뮬레이션 실행 (시드·설정·엔진 버전이 같으면 같은 데이터)
CREATE TABLE sim.run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seed integer NOT NULL CHECK (seed >= 0),
  config jsonb NOT NULL,
  engine_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 주입한 고장·데이터 품질 시나리오 (정답). 사이트·설비는 코드로 적는다 (om 행과 FK로 묶지 않음).
CREATE TABLE sim.injection (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES sim.run (id) ON DELETE CASCADE,
  site_code text NOT NULL,
  asset_path text, -- 예: SIM-B/ESS1/RACK03. NULL = 사이트·게이트웨이 단위 (통신 단절 등)
  kind text NOT NULL, -- lib/sim 시나리오 kind
  start_ts timestamptz NOT NULL,
  end_ts timestamptz, -- NULL = 순간 이벤트
  params jsonb NOT NULL DEFAULT '{}',
  expected_failure_modes text[] NOT NULL DEFAULT '{}',
  CHECK (end_ts IS NULL OR end_ts >= start_ts)
);
CREATE INDEX injection_run_id_idx ON sim.injection (run_id);

-- 탐지기별 평가 결과 (설계 §5.5 CI 게이트: 재현율·정밀도·자산월당 오탐·탐지 지연·크기 MAE)
CREATE TABLE sim.eval_result (
  run_id bigint NOT NULL REFERENCES sim.run (id) ON DELETE CASCADE,
  detector_id text NOT NULL,
  tp integer NOT NULL CHECK (tp >= 0),
  fp integer NOT NULL CHECK (fp >= 0),
  fn integer NOT NULL CHECK (fn >= 0),
  recall double precision CHECK (recall BETWEEN 0 AND 1), -- NULL = 정답 주입이 없음
  precision double precision CHECK (precision BETWEEN 0 AND 1), -- NULL = 탐지가 없음
  fp_per_asset_month double precision CHECK (fp_per_asset_month >= 0),
  median_delay_days double precision,
  magnitude_mae double precision CHECK (magnitude_mae >= 0),
  details jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, detector_id)
);

-- Down Migration
DROP TABLE IF EXISTS sim.eval_result;
DROP TABLE IF EXISTS sim.injection;
DROP TABLE IF EXISTS sim.run;
DROP SCHEMA IF EXISTS sim;

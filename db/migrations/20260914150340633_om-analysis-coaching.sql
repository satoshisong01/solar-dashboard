-- Up Migration
-- P2 분석·코칭 (설계 §5.2 파생·분석·코칭, §0 확정 결정).
-- 분석은 관리자가 사이트·설비·기간을 골라 수동으로만 실행한다(크론 없음). 결과는 finding(발견사항)으로만 저장하고,
-- 리포트는 관리자가 따로 "리포트 만들기"로 만든다(분석이 리포트를 자동 생성하지 않음). 메일 발송 기록 테이블은 두지 않는다.

-- 관리자가 "분석 실행"을 누를 때마다 한 행.
-- scope: {"siteIds": [1, 2], "assetIds": [10, 11](선택), "from": ISO 시각, "to": ISO 시각}
--
-- 동시 실행 방지 방침 (실행 코드가 지킨다):
--   실행기는 전용 연결 하나에서 대상 사이트 id 오름차순으로
--     SELECT pg_try_advisory_lock(hashtext('om.analysis_run'), <site_id>)
--   를 시도한다. 하나라도 false면 같은 사이트 분석이 이미 진행 중이므로 잡은 잠금을 모두 풀고 새 행을 만들지 않고 거절한다.
--   기간이 겹치지 않아도 같은 사이트면 막는다 (에피소드·KPI·finding upsert가 사이트 단위로 겹치므로 사이트 단위로 직렬화).
--   잠금은 실행이 끝나면 finally에서 pg_advisory_unlock으로 풀고, 프로세스가 죽으면 연결이 끊기며 풀린다.
--   따라서 status='running'인데 그 사이트 잠금이 비어 있는 행은 중단된 실행이다 (다음 실행이 시작할 때 failed로 정리).
CREATE TABLE om.analysis_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_by text NOT NULL,
  scope jsonb NOT NULL CHECK ((
    jsonb_typeof(scope) = 'object'
    AND jsonb_typeof(scope -> 'siteIds') = 'array' AND scope -> 'siteIds' <> '[]'::jsonb
    AND (NOT scope ? 'assetIds' OR jsonb_typeof(scope -> 'assetIds') = 'array')
    AND jsonb_typeof(scope -> 'from') = 'string' AND jsonb_typeof(scope -> 'to') = 'string'
  ) IS TRUE),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'partial')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}',
  error text,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX analysis_run_started_at_idx ON om.analysis_run (started_at);

-- 운전 에피소드(충전 세션, 정상운전 구간 등). 영구 보관: 원시 보존과 무관한 장기 비교의 근거.
-- 같은 설비·종류·시작 시각이면 추출기를 다시 돌려도 같은 행을 upsert한다.
CREATE TABLE om.episode (
  asset_id integer NOT NULL REFERENCES om.asset (id),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$'), -- 예: ess.charge
  start_ts timestamptz NOT NULL,
  end_ts timestamptz NOT NULL,
  extractor_version text NOT NULL,
  features jsonb NOT NULL DEFAULT '{}', -- ah_in, duration_s 등
  conditions jsonb NOT NULL DEFAULT '{}', -- 같은 조건 비교용 bin (C-rate, 셀온도 등)
  dq jsonb NOT NULL DEFAULT '{}', -- 완결성·품질 비트 요약
  valid boolean NOT NULL,
  invalid_reason text,
  run_id bigint REFERENCES om.analysis_run (id),
  PRIMARY KEY (asset_id, kind, start_ts),
  CHECK (end_ts > start_ts),
  CHECK (valid = (invalid_reason IS NULL))
);
CREATE INDEX episode_kind_start_ts_idx ON om.episode (kind, start_ts);

-- 일별 KPI. day는 KST 날짜. scope_id는 scope_type에 따라 site.id 또는 asset.id (다형이라 FK 없음). 영구 보관.
CREATE TABLE om.kpi_daily (
  scope_type text NOT NULL CHECK (scope_type IN ('site', 'asset')),
  scope_id integer NOT NULL,
  day date NOT NULL,
  kpi_key text NOT NULL CHECK (kpi_key ~ '^[a-z][a-z0-9]*(\.[a-z0-9_]+)*$'),
  value double precision, -- NULL = 데이터 부족으로 계산하지 않음
  unit text NOT NULL,
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  dq_completeness real CHECK (dq_completeness BETWEEN 0 AND 1),
  calc_version text NOT NULL,
  PRIMARY KEY (scope_type, scope_id, day, kpi_key)
);

-- 탐지기 파라미터. 바꿀 때는 기존 행을 고치지 않고 새 version 행을 추가한다 (finding이 쓴 설정을 재현할 수 있게).
-- scope: 'default' | 'class:<asset_class.key>' | 'asset:<asset.id>' (좁은 범위가 우선)
CREATE TABLE om.detector_config (
  detector_id text NOT NULL CHECK (detector_id ~ '^[a-z][a-z0-9]*\.[a-z0-9_]+$'), -- 예: ess.capacity_fade
  scope text NOT NULL CHECK (scope = 'default' OR scope ~ '^class:[a-z][a-z0-9]*(\.[a-z0-9_]+)*$' OR scope ~ '^asset:[1-9][0-9]*$'),
  version integer NOT NULL CHECK (version >= 1),
  params jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  reference_window tstzrange CHECK (
    reference_window IS NULL OR (NOT isempty(reference_window) AND NOT lower_inf(reference_window) AND NOT upper_inf(reference_window))
  ),
  active boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (detector_id, scope, version)
);
-- (탐지기, 범위)마다 활성 버전은 하나. 새 버전을 켤 때 같은 트랜잭션에서 이전 버전을 끈다.
CREATE UNIQUE INDEX detector_config_active_uq ON om.detector_config (detector_id, scope) WHERE active;

-- 발견사항. dedup_key = 탐지기·자산·고장모드 (탐지 창 제외) → 분석을 다시 돌려도 열린 건은 하나만 두고 갱신한다.
-- 닫힌(verified·dismissed) 뒤 같은 문제가 다시 나오면 새 행을 만들고 previous_finding_id로 잇는다 (재발).
CREATE TABLE om.finding (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES om.site (id),
  asset_id integer REFERENCES om.asset (id), -- NULL = 사이트 단위 (예: 수소 물질수지)
  detector_id text NOT NULL,
  detector_version text NOT NULL,
  failure_mode text NOT NULL,
  category text NOT NULL CHECK (category IN ('performance', 'degradation', 'data_quality', 'safety', 'availability')),
  dedup_key text NOT NULL,
  severity smallint NOT NULL CHECK (severity BETWEEN 1 AND 5),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'triaged', 'in_report', 'action_taken', 'verified', 'dismissed', 'reopened')),
  title text NOT NULL,
  summary text NOT NULL,
  effect jsonb NOT NULL DEFAULT '{}', -- 효과 크기·95% CI 등
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  first_detected_at timestamptz NOT NULL,
  last_detected_at timestamptz NOT NULL,
  detection_count integer NOT NULL DEFAULT 1 CHECK (detection_count >= 1),
  latest_evidence_id bigint, -- FK는 아래 finding_evidence를 만든 뒤 추가한다
  previous_finding_id bigint REFERENCES om.finding (id),
  suppressed_until timestamptz,
  dismiss_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end >= window_start),
  CHECK (last_detected_at >= first_detected_at),
  CHECK (category <> 'safety' OR severity >= 4), -- 안전 카테고리는 severity 4 이상 고정 (설계 §5.3)
  CHECK (status <> 'dismissed' OR dismiss_reason IS NOT NULL) -- 기각 사유 필수
);
-- 열린 finding은 dedup_key당 하나
CREATE UNIQUE INDEX finding_open_dedup_key_uq ON om.finding (dedup_key) WHERE status NOT IN ('verified', 'dismissed');
CREATE INDEX finding_site_status_idx ON om.finding (site_id, status);
CREATE INDEX finding_asset_id_idx ON om.finding (asset_id) WHERE asset_id IS NOT NULL;

-- 근거 스냅샷. append-only: 행을 고치지 않고 탐지할 때마다 추가한다 (bin 통계, ≤120점 다운샘플 시계열 등).
-- 리포트 인용과 (향후) LLM 입력의 원천. input_hash로 같은 입력인지 확인한다.
CREATE TABLE om.finding_evidence (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id bigint NOT NULL REFERENCES om.finding (id),
  run_id bigint NOT NULL REFERENCES om.analysis_run (id),
  computed_at timestamptz NOT NULL DEFAULT now(),
  input_hash text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  UNIQUE (id, finding_id) -- finding.latest_evidence_id가 같은 finding의 근거만 가리키게 하는 FK 대상
);
CREATE INDEX finding_evidence_finding_computed_idx ON om.finding_evidence (finding_id, computed_at);

ALTER TABLE om.finding
  ADD CONSTRAINT finding_latest_evidence_fk
  FOREIGN KEY (latest_evidence_id, id) REFERENCES om.finding_evidence (id, finding_id);

-- 상태 전이 이력. from_status NULL = 생성. verified는 조치 효과 검증(system)만 만든다.
CREATE TABLE om.finding_transition (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id bigint NOT NULL REFERENCES om.finding (id),
  from_status text CHECK (from_status IN ('new', 'triaged', 'in_report', 'action_taken', 'verified', 'dismissed', 'reopened')),
  to_status text NOT NULL CHECK (to_status IN ('new', 'triaged', 'in_report', 'action_taken', 'verified', 'dismissed', 'reopened')),
  actor text NOT NULL, -- 관리자 이메일 또는 'system'
  note text,
  at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status IS DISTINCT FROM to_status),
  CHECK (to_status <> 'verified' OR actor = 'system')
);
CREATE INDEX finding_transition_finding_at_idx ON om.finding_transition (finding_id, at);

-- 현장 정비 조치 (콘솔 직접 기록 또는 CSV 가져오기).
-- expected_effect: {"metric": "ess.capacity_ah", "direction": "increase"|"decrease", "min_delta": 숫자, "stabilization_days": 숫자}
CREATE TABLE om.maintenance_action (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES om.site (id),
  asset_id integer NOT NULL REFERENCES om.asset (id),
  finding_id bigint REFERENCES om.finding (id), -- NULL = 발견사항과 무관한 정기 정비 등
  action_type text NOT NULL,
  performed_at timestamptz NOT NULL,
  performed_by text,
  notes text,
  expected_effect jsonb CHECK (expected_effect IS NULL OR (
    jsonb_typeof(expected_effect) = 'object'
    AND jsonb_typeof(expected_effect -> 'metric') = 'string'
    AND expected_effect ->> 'direction' IN ('increase', 'decrease')
    AND jsonb_typeof(expected_effect -> 'min_delta') = 'number'
    AND jsonb_typeof(expected_effect -> 'stabilization_days') = 'number'
  ) IS TRUE),
  source text NOT NULL CHECK (source IN ('manual', 'csv')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_action_site_performed_idx ON om.maintenance_action (site_id, performed_at);
CREATE INDEX maintenance_action_finding_id_idx ON om.maintenance_action (finding_id) WHERE finding_id IS NOT NULL;

-- 조치 전후를 같은 조건으로 비교한 효과 검증. 조치·방법마다 하나 (다시 계산하면 upsert).
CREATE TABLE om.action_verification (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_id bigint NOT NULL REFERENCES om.maintenance_action (id),
  method text NOT NULL,
  before_window tstzrange NOT NULL,
  after_window tstzrange NOT NULL,
  before_stats jsonb NOT NULL DEFAULT '{}',
  after_stats jsonb NOT NULL DEFAULT '{}',
  effect double precision,
  ci_low double precision,
  ci_high double precision,
  verdict text NOT NULL CHECK (verdict IN ('improved', 'no_change', 'worse', 'insufficient_data')),
  computed_at timestamptz NOT NULL DEFAULT now(),
  run_id bigint NOT NULL REFERENCES om.analysis_run (id),
  UNIQUE (action_id, method),
  CHECK (before_window << after_window), -- 전 구간이 후 구간보다 앞 (비어 있으면 거부)
  CHECK (ci_low IS NULL OR ci_high IS NULL OR ci_low <= ci_high),
  CHECK (verdict = 'insufficient_data' OR effect IS NOT NULL)
);

-- 리포트 초안. 관리자가 "리포트 만들기"로 만든다: EvidencePack(pack) → composer → draft → validateDraft(validation).
-- 같은 사이트·기간·composer·팩이면 같은 행 (다시 눌러도 중복 생성하지 않음). PDF는 인쇄용 화면으로 출력하고 파일로 저장하지 않는다.
CREATE TABLE om.report (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES om.site (id),
  period tstzrange NOT NULL CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  composer_id text NOT NULL, -- 예: templateComposer@1
  pack jsonb NOT NULL,
  pack_hash text NOT NULL,
  draft jsonb NOT NULL,
  validation jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  UNIQUE (site_id, period, composer_id, pack_hash),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (status <> 'approved' OR approved_at IS NOT NULL)
);
-- 사이트·기간마다 승인본은 하나. 새 초안을 승인하면 같은 트랜잭션에서 이전 승인본을 superseded로 바꾼다.
CREATE UNIQUE INDEX report_approved_uq ON om.report (site_id, period) WHERE status = 'approved';
CREATE INDEX report_site_created_at_idx ON om.report (site_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS om.report;
DROP TABLE IF EXISTS om.action_verification;
DROP TABLE IF EXISTS om.maintenance_action;
DROP TABLE IF EXISTS om.finding_transition;
ALTER TABLE IF EXISTS om.finding DROP CONSTRAINT IF EXISTS finding_latest_evidence_fk;
DROP TABLE IF EXISTS om.finding_evidence;
DROP TABLE IF EXISTS om.finding;
DROP TABLE IF EXISTS om.detector_config;
DROP TABLE IF EXISTS om.kpi_daily;
DROP TABLE IF EXISTS om.episode;
DROP TABLE IF EXISTS om.analysis_run;

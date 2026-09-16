-- Up Migration
-- AI 설명 (설계 §5.4 LLM 연결 지점). 판정과 수치는 분석 엔진이 내고, 이 표에는 문장과 그 출처만 담는다.
-- 같은 근거(evidence_id)면 그대로 재사용하고 근거가 바뀌면 새 행을 만든다 — 화면을 볼 때마다 모델을 부르지 않는다.
--   source      llm = 생성 문장을 채택 · template = 부르지 않았거나 실패·검증 불통과라 틀 문장으로 되돌림 (사유는 validation)
--   text        {"what": …, "basis": …|null, "outlook": …|null, "nextStep": …|null, "hold": bool} — 화면에 그대로 쓰는 쉬운 말 4줄
--   validation  {"ok": bool, "reason": …|null, "detail": …, "issues": [{code, line, message}, …]}
CREATE TABLE om.finding_explanation (
  finding_id bigint NOT NULL REFERENCES om.finding (id),
  evidence_id bigint NOT NULL,
  source text NOT NULL CHECK (source IN ('template', 'llm')),
  model text,
  prompt_version text NOT NULL,
  text jsonb NOT NULL CHECK (jsonb_typeof(text) = 'object'),
  validation jsonb NOT NULL CHECK (jsonb_typeof(validation) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (finding_id, evidence_id), -- UNIQUE(finding_id, evidence_id): 같은 근거면 한 행
  -- 근거는 반드시 그 발견사항의 것이어야 한다 (om.finding_evidence의 UNIQUE(id, finding_id)를 가리킨다)
  FOREIGN KEY (evidence_id, finding_id) REFERENCES om.finding_evidence (id, finding_id),
  CHECK (source <> 'llm' OR model IS NOT NULL)
);

-- AI 설명 사용 여부. site_id가 NULL인 행 하나가 전역값이고, 사이트 행이 있으면 그 사이트에서 앞선다.
-- 행이 없으면 GEMINI_API_KEY가 있을 때 켠 것으로 본다 (lib/ops/ai-settings.ts).
CREATE TABLE om.ai_explanation_setting (
  site_id smallint REFERENCES om.site (id),
  enabled boolean NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 전역 행은 하나뿐 (NULL은 UNIQUE로 막히지 않으므로 식 인덱스로 막는다), 사이트 행도 사이트마다 하나
CREATE UNIQUE INDEX ai_explanation_setting_global_uq ON om.ai_explanation_setting ((site_id IS NULL)) WHERE site_id IS NULL;
CREATE UNIQUE INDEX ai_explanation_setting_site_uq ON om.ai_explanation_setting (site_id) WHERE site_id IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS om.ai_explanation_setting;
DROP TABLE IF EXISTS om.finding_explanation;

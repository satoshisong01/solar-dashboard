-- Up Migration
-- 분석 데스크 종합 요약 (설계 §5.4 LLM 연결 지점). 발견사항 한 건이 아니라 사이트 전체(또는 한 사이트)의 열린 발견사항을 묶은 문장이다.
-- om.finding_explanation과 달리 가리킬 근거 행이 없으므로 발견사항 묶음의 지문(findings_hash)을 키로 쓴다.
-- 지문이 같으면 저장된 문장을 그대로 쓰고, 발견사항이 하나라도 생기거나 상태·심각도가 바뀌면 새 행을 만든다.
--   scope_key      'ALL' = 사이트 전체 · 그 밖은 사이트 코드 (사이트 필터가 걸린 화면)
--   findings_hash  모델에 보내는 것의 안정 해시 — 건수·id·상태·심각도(lib/desk/digest/stats.ts) + 프롬프트 버전 + 엔진이 만든 틀 문장
--   source         llm = 생성 문장을 채택 · template = 부르지 않았거나 실패·검증 불통과라 틀 문장으로 되돌림 (사유는 validation)
--   text           {"headline": …, "breakdown": …|null, "urgency": …|null, "nextStep": …|null} — 화면에 그대로 쓰는 4줄
--   validation     {"ok": bool, "reason": …|null, "detail": …, "issues": [{code, line, message}, …]}
CREATE TABLE om.finding_digest (
  scope_key text NOT NULL,
  findings_hash text NOT NULL,
  source text NOT NULL CHECK (source IN ('template', 'llm')),
  model text,
  prompt_version text NOT NULL,
  text jsonb NOT NULL CHECK (jsonb_typeof(text) = 'object'),
  validation jsonb NOT NULL CHECK (jsonb_typeof(validation) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key, findings_hash),
  CHECK (source <> 'llm' OR model IS NOT NULL)
);

-- 발견사항이 바뀌면 옛 지문 행은 다시 쓰이지 않는다. 범위별로 오래된 행부터 지울 때 쓴다
CREATE INDEX finding_digest_created_at_idx ON om.finding_digest (scope_key, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS om.finding_digest;

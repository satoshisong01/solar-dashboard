-- Up Migration
-- 안전 화면의 "수신 지연"(서버 수신 시각 − 이벤트 발생 시각)을 보여 주기 위해 이벤트의 서버 수신 시각을 남긴다.
-- 이 컬럼이 생기기 전에 받은 이벤트는 수신 시각을 알 수 없으므로 NULL로 둔다 (추정값으로 채우지 않는다).
ALTER TABLE om.event_log ADD COLUMN received_at timestamptz;

-- Down Migration
ALTER TABLE om.event_log DROP COLUMN IF EXISTS received_at;

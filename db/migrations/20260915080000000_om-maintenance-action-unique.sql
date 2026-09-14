-- Up Migration
-- 같은 설비·조치 종류·수행일시의 정비 조치는 한 행만 둔다 (CSV를 두 번 가져오거나 두 사람이 동시에 가져와도 중복이 생기지 않게).
-- 기존 중복 행을 지우는 사전 정리는 하지 않는다: 중복이 있으면 이 마이그레이션이 실패하므로 원인을 확인한 뒤 사람이 정리한다.
-- action_type은 저장 전에 앞뒤 공백을 지운다 (lib/analysis/transitions.ts).
CREATE UNIQUE INDEX maintenance_action_asset_type_performed_uniq ON om.maintenance_action (asset_id, action_type, performed_at);

-- Down Migration
DROP INDEX IF EXISTS om.maintenance_action_asset_type_performed_uniq;

-- Up Migration
-- 도면 계장 태그(P&ID tag, 예: PT-201)를 포인트에 기록한다. 공정도 화면이 태그로 포인트를 찾는다.
-- source_key는 게이트웨이가 보내는 원본 태그(벤더 PLC 이름)라 도면 태그와 다르고,
-- qualifier는 (asset, metric, qualifier) 유일성과 탐지기 입력 선택에 쓰므로 둘 다 태그 자리로 쓸 수 없다.
ALTER TABLE om.point ADD COLUMN instrument_tag text CHECK (instrument_tag <> '');
-- 같은 물리 계기를 두 포인트에 매핑하지 않는다 (UNIQUE (gateway_id, source_key)와 같은 범위).
CREATE UNIQUE INDEX point_gateway_instrument_tag_key ON om.point (gateway_id, instrument_tag) WHERE instrument_tag IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS om.point_gateway_instrument_tag_key;
ALTER TABLE om.point DROP COLUMN IF EXISTS instrument_tag;

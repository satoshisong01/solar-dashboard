-- Up Migration
-- 외부 수소 반입 기록 (한 건 = 한 행). 텔레메트리가 아니라 전표·장부 값이라 m_1h가 아니라 별도 표에 둔다.
-- 수소 원장(lib/analytics/ledger/hydrogen.ts)의 delivered 항이 하역 적산계(h2.delivery.mass.total)가 없을 때 이 표를 2순위로 쓴다.
-- 입력 경로는 정비이력과 같다: 직접 입력 + CSV 가져오기 (source).
CREATE TABLE om.h2_delivery (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id smallint NOT NULL REFERENCES om.site (id),
  asset_id integer REFERENCES om.asset (id), -- 반입 설비·트레일러 자산 (없으면 NULL)
  delivered_at timestamptz NOT NULL,         -- 하역 완료 시각. KST 날짜로 원장 일에 귀속된다
  supplier text NOT NULL CHECK (supplier <> ''),
  vehicle_no text CHECK (vehicle_no <> ''),  -- 차량번호·전표번호
  mass_kg double precision NOT NULL CHECK (mass_kg >= 0),      -- 전표 인수량 [kg]
  heel_mass_kg double precision CHECK (heel_mass_kg >= 0),     -- 반환 잔량(heel) [kg]
  unit_price_krw double precision CHECK (unit_price_krw >= 0), -- 반입 단가 [원/kg]
  amount_krw double precision CHECK (amount_krw >= 0),         -- 금액 [원] (단가 × 수량과 다를 수 있어 따로 받는다)
  purity_pct double precision CHECK (purity_pct > 0 AND purity_pct <= 100),
  note text,
  source text NOT NULL CHECK (source IN ('manual', 'csv')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 원장이 날짜 구간으로 읽는다
CREATE INDEX h2_delivery_site_delivered_idx ON om.h2_delivery (site_id, delivered_at);
-- CSV 재업로드·중복 입력 방지. 차량번호가 없는 건은 공급사·시각으로만 본다 (COALESCE로 NULL을 빈 값 취급)
CREATE UNIQUE INDEX h2_delivery_dedupe_key ON om.h2_delivery (site_id, delivered_at, supplier, COALESCE(vehicle_no, ''));

-- Down Migration
DROP TABLE IF EXISTS om.h2_delivery;

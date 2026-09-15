-- Up Migration
-- P3 사이트 에너지·수소 체인 원장 (설계 §5.2 site_energy_daily). 한 행 = 사이트 하나의 KST 하루.
-- 분석 실행이 m_1h(1시간 롤업)에서 계산해 upsert한다(겹침 구간은 다시 계산해 덮어쓴다). 원시 측정값은 읽지 않는다.
-- 할당은 회계 가정(pool_hourly@1: 한 시간 안의 전력은 섞인다)이며 청정수소 인증 공식 산정이 아니다.
--   flows_kwh      [{from, to, kwh}] 공급(pv·ess_discharge·fc·grid_import·unmetered) → 수요(site_aux·ess_charge·electrolyzer·compressor·grid_export·unmetered)
--   energy_kwh     노드별 합계 {pv, ess_discharge, fc, grid_import, site_aux, ess_charge, electrolyzer, electrolyzer_system, compressor, grid_export, unmetered_supply, unmetered_demand}
--   h2_kg          {produced, fc_consumed, stored_delta, vented_est, residual, residual_pct, method{…}, aux{faraday_expected, purge_count, tank_temp_delta_c}}
--   pv_loss_kwh    {expected, actual, outage, ess_full, curtailment, clipping, derating, soiling_est, unexplained} (합계 = expected − actual). 기준 PR이 없으면 NULL
--   dq             {energy{completeness, aux_basis, …}, h2{completeness, …}, pv{completeness, pr_ref, …}}
CREATE TABLE om.site_energy_daily (
  site_id smallint NOT NULL REFERENCES om.site (id),
  day date NOT NULL,
  flows_kwh jsonb NOT NULL CHECK (jsonb_typeof(flows_kwh) = 'array'),
  energy_kwh jsonb NOT NULL CHECK (jsonb_typeof(energy_kwh) = 'object'),
  h2_kg jsonb NOT NULL CHECK (jsonb_typeof(h2_kg) = 'object'),
  elz_grid_share real CHECK (elz_grid_share BETWEEN 0 AND 1),
  renewable_share real CHECK (renewable_share BETWEEN 0 AND 1),
  elz_sec_kwh_per_kg double precision CHECK (elz_sec_kwh_per_kg > 0),
  fc_kg_per_mwh double precision CHECK (fc_kg_per_mwh > 0),
  p2p_efficiency real CHECK (p2p_efficiency >= 0),
  pv_loss_kwh jsonb CHECK (pv_loss_kwh IS NULL OR jsonb_typeof(pv_loss_kwh) = 'object'),
  dq jsonb NOT NULL CHECK (jsonb_typeof(dq) = 'object'),
  alloc_version text NOT NULL CHECK (alloc_version ~ '^[a-z][a-z0-9_]*@[0-9]+$'),
  calc_version text NOT NULL CHECK (calc_version ~ '^[a-z][a-z0-9_]*@[0-9]+$'),
  run_id bigint NOT NULL REFERENCES om.analysis_run (id),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, day),
  -- 전해조 전력 중 계통·재생 비율은 함께 있거나 함께 없다
  CHECK ((elz_grid_share IS NULL) = (renewable_share IS NULL))
);

-- Down Migration
DROP TABLE IF EXISTS om.site_energy_daily;

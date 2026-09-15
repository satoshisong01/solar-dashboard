import 'server-only';
// 사이트 상세 체인 원장 섹션 조회: om.site_energy_daily 기간 행 + 물질수지 임계(활성 탐지기 설정) + 열린 물질수지 발견사항.
import { sql } from 'kysely';
import { loadActiveDetectorConfigs } from '@/lib/analysis/catalog';
import { CLOSED_STATUSES } from '@/lib/analysis/transition-rules';
import { h2ChainMassBalanceGap, H2_MASS_BALANCE_DEFAULTS } from '@/lib/analytics/detectors/h2chain-mass-balance';
import { ALLOC_VERSION, type SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { resolveDetectorConfig } from '@/lib/analytics/pipeline/config';
import { parseLedgerRow, type LedgerDbRow } from '@/lib/chain/parse';
import type { ChainPeriod } from '@/lib/chain/period';
import { db } from '@/lib/db/kysely';

const MASS_BALANCE = 'h2chain.mass_balance_gap';

export interface MassBalanceThreshold {
  readonly residualPct: number;
  readonly minCompleteness: number;
  /** 적용 설정 'default@3' 목록 (없으면 코드 기본값) */
  readonly applied: readonly string[];
  /** 활성 설정이 검증에 실패해 코드 기본값으로 그렸으면 사유 */
  readonly invalidReason: string | null;
}

export interface OpenChainFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: number;
  readonly status: string;
  readonly lastDetectedMs: number;
}

export interface ChainView {
  readonly days: readonly SiteEnergyDay[];
  /** 이 사이트에 저장된 가장 최근 원장 날짜 (기간과 무관) */
  readonly lastDay: string | null;
  readonly threshold: MassBalanceThreshold;
  readonly openFindings: readonly OpenChainFinding[];
}

/** 물질수지 잔차율 기준·완결성 기준 (활성 설정 → 코드 기본값). 체인 원장 섹션·플릿 원장 신호가 같이 쓴다 */
export async function massBalanceThreshold(): Promise<MassBalanceThreshold> {
  const configs = await loadActiveDetectorConfigs(db);
  // 물질수지는 사이트 단위 실행이라 default 범위만 적용된다 (lib/analytics/pipeline/targets.ts)
  const resolved = resolveDetectorConfig(configs, MASS_BALANCE, null, h2ChainMassBalanceGap);
  const params = resolved.ok ? resolved.params : H2_MASS_BALANCE_DEFAULTS;
  return { residualPct: params.residualPct, minCompleteness: params.minCompleteness, applied: resolved.versions, invalidReason: resolved.ok ? null : resolved.reason };
}

export async function getSiteChain(siteId: number, period: ChainPeriod): Promise<ChainView> {
  const [rows, last, threshold, findings] = await Promise.all([
    sql<LedgerDbRow>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, flows_kwh, energy_kwh, h2_kg, elz_grid_share, renewable_share, elz_sec_kwh_per_kg, fc_kg_per_mwh, p2p_efficiency, pv_loss_kwh, dq, calc_version
      FROM om.site_energy_daily
      WHERE site_id = ${siteId} AND alloc_version = ${ALLOC_VERSION} AND day BETWEEN ${period.fromDay}::date AND ${period.toDay}::date
      ORDER BY day
    `.execute(db),
    sql<{ day: string | null }>`SELECT to_char(max(day), 'YYYY-MM-DD') AS day FROM om.site_energy_daily WHERE site_id = ${siteId}`.execute(db),
    massBalanceThreshold(),
    db
      .selectFrom('om.finding')
      .select(['id', 'title', 'severity', 'status', 'last_detected_at'])
      .where('site_id', '=', siteId)
      .where('detector_id', '=', MASS_BALANCE)
      .where('status', 'not in', [...CLOSED_STATUSES])
      .orderBy('last_detected_at', 'desc')
      .execute(),
  ]);
  return {
    days: rows.rows.map(parseLedgerRow),
    lastDay: last.rows[0]?.day ?? null,
    threshold,
    openFindings: findings.map((f) => ({ id: f.id, title: f.title, severity: f.severity, status: f.status, lastDetectedMs: f.last_detected_at.getTime() })),
  };
}

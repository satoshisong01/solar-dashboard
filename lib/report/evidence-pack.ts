// EvidencePack 조립 (순수, 설계 §5.4): DB에서 읽은 행(load.ts) → om.evidence-pack.v1.
// 같은 입력이면 generatedAt만 달라도 같은 팩 해시가 나온다 (해시는 generatedAt·packHash를 뺀 안정 JSON).
import { KPI_CALC_VERSION } from '@/lib/analytics/kpi/daily';
import { hashInput } from '@/lib/analytics/hash';
import { PLAYBOOKS } from '@/lib/analytics/playbooks';
import { parseEffect } from '@/lib/desk/effect';
import { detectorLabel } from '@/lib/desk/labels';
import type { SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { MESSAGE_TEMPLATE_VERSION } from './messages/version';
import { summarizeEvidence, roundTo } from './pack-evidence';
import { energyLedgerOf } from './pack-ledger';
import { dataQualityOf, kpiAssetSummaries, kpiSummaries, revenueOf, verifiedActionsOf, type KpiRowInput, type MarketRowInput, type VerificationInput } from './pack-sections';
import { byReportOrder, dataSpanOf, impactOf, judgementOf, MIN_DATA_SPANS, pickTodo, priorityOf, SEVERE_THRESHOLD } from './planner';
import {
  EVIDENCE_PACK_SCHEMA,
  REPORT_ENGINE_VERSION,
  type EvidencePack,
  type PackEffect,
  type PackEnergy,
  type PackFinding,
  type PackPeriod,
  type PackPlaybook,
  type PackSelection,
  type PackSite,
  type PackTransition,
} from './pack-types';

export interface FindingInput {
  readonly id: string;
  readonly assetId: number | null;
  readonly assetPath: string | null;
  readonly assetCriticality: number | null;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly failureMode: string;
  readonly category: string;
  readonly title: string;
  readonly severity: number;
  readonly confidence: number;
  readonly status: string;
  /** finding.effect jsonb */
  readonly effect: unknown;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly firstDetectedAt: number;
  readonly lastDetectedAt: number;
  readonly detectionCount: number;
  readonly previousFindingId: string | null;
  readonly evidenceId: string | null;
  readonly evidenceComputedAt: number | null;
  /** 최신 finding_evidence.snapshot jsonb */
  readonly snapshot: unknown;
  readonly transitions: readonly PackTransition[];
  readonly actions: readonly { readonly id: string; readonly actionType: string; readonly performedAt: number }[];
}

export interface PackInput {
  readonly site: PackSite;
  readonly period: PackPeriod;
  readonly selection: PackSelection;
  readonly generatedAt: number;
  readonly findings: readonly FindingInput[];
  readonly kpiRows: readonly KpiRowInput[];
  readonly energy: PackEnergy;
  readonly verifications: readonly VerificationInput[];
  readonly market: readonly MarketRowInput[];
  /** 기간 안 끝난 날의 체인 원장 일 행 (om.site_energy_daily). 팩에는 기간 합만 넣는다 */
  readonly ledgerDays: readonly SiteEnergyDay[];
}

const TRANSITION_LIMIT = 10;
const EFFECT_DIGITS = 4;

function playbookOf(failureMode: string): PackPlaybook | null {
  if (!Object.hasOwn(PLAYBOOKS, failureMode)) return null;
  const playbook = PLAYBOOKS[failureMode as keyof typeof PLAYBOOKS];
  return { title: playbook.title, actions: [...playbook.actions], inspections: [...playbook.inspections], falsePositiveTraps: [...playbook.falsePositiveTraps] };
}

function effectOf(raw: unknown): PackEffect {
  const e = parseEffect(raw);
  const r = (v: number | null) => roundTo(v, EFFECT_DIGITS);
  return { metric: e.metric, value: r(e.value), unit: e.unit, ciLow: r(e.ciLow), ciHigh: r(e.ciHigh), baseline: r(e.baseline), current: r(e.current), levelUnit: e.levelUnit };
}

export function packFindingOf(input: FindingInput, siteCode: string): PackFinding {
  const effect = effectOf(input.effect);
  const evidence = summarizeEvidence(input.snapshot, effect, input.detectorId);
  const dataSpan = dataSpanOf(input.detectorId, evidence, { start: input.windowStart, end: input.windowEnd });
  const minDataSpan = MIN_DATA_SPANS[input.detectorId] ?? null;
  const confidence = roundTo(input.confidence, 3) ?? 0;
  const impact = impactOf(input.detectorId, effect.value, evidence, input.assetCriticality);
  return {
    id: input.id,
    assetId: input.assetId,
    assetPath: input.assetPath ?? siteCode,
    assetCriticality: input.assetCriticality,
    detectorId: input.detectorId,
    detectorVersion: input.detectorVersion,
    detectorLabel: detectorLabel(input.detectorId),
    failureMode: input.failureMode,
    category: input.category,
    title: input.title,
    severity: input.severity,
    confidence,
    status: input.status,
    effect,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    evidenceId: input.evidenceId,
    evidenceComputedAt: input.evidenceComputedAt,
    evidence,
    playbook: playbookOf(input.failureMode),
    history: {
      firstDetectedAt: input.firstDetectedAt,
      lastDetectedAt: input.lastDetectedAt,
      detectionCount: input.detectionCount,
      previousFindingId: input.previousFindingId,
      transitions: input.transitions.slice(-TRANSITION_LIMIT),
      actions: [...input.actions],
    },
    dataSpan,
    minDataSpan,
    judgement: judgementOf({ confidence, detectionCount: input.detectionCount, dataSpan, minDataSpan }),
    impact,
    priority: priorityOf(input.severity, confidence, impact),
  };
}

/** 팩 해시: generatedAt·packHash를 뺀 안정 JSON 해시 (키 순서 무관) */
export function computePackHash(pack: EvidencePack): string {
  return hashInput({ ...pack, provenance: { ...pack.provenance, generatedAt: null, packHash: null } });
}

export function buildEvidencePack(input: PackInput): EvidencePack {
  const findings = input.findings.map((f) => packFindingOf(f, input.site.code)).sort(byReportOrder);
  const kpiByAsset = kpiAssetSummaries(input.kpiRows);
  const verifiedActions = input.selection.includeVerifiedActions ? verifiedActionsOf(input.verifications) : [];
  const unhashed: EvidencePack = {
    schema: EVIDENCE_PACK_SCHEMA,
    site: input.site,
    period: input.period,
    selection: { findingIds: [...input.selection.findingIds].sort((a, b) => Number(a) - Number(b)), includeVerifiedActions: input.selection.includeVerifiedActions, basedOnReportId: input.selection.basedOnReportId },
    stats: {
      findingCount: findings.length,
      severeThreshold: SEVERE_THRESHOLD,
      severeCount: findings.filter((f) => f.severity >= SEVERE_THRESHOLD).length,
      holdCount: findings.filter((f) => f.judgement === 'hold').length,
      verifiedActionCount: verifiedActions.length,
      improvedCount: verifiedActions.filter((a) => a.verdict === 'improved').length,
    },
    energySummary: {
      pvKwh: roundTo(input.energy.pvKwh, 1),
      essChargeKwh: roundTo(input.energy.essChargeKwh, 1),
      essDischargeKwh: roundTo(input.energy.essDischargeKwh, 1),
      h2Kg: roundTo(input.energy.h2Kg, 2),
      fcKwh: roundTo(input.energy.fcKwh, 1),
    },
    kpis: kpiSummaries(input.kpiRows, kpiByAsset),
    kpiByAsset,
    findings,
    todo: pickTodo(findings),
    dataQuality: dataQualityOf(kpiByAsset, findings.filter((f) => f.category === 'data_quality').map((f) => f.id)),
    verifiedActions,
    revenueSummary: revenueOf(input.market),
    energyLedger: energyLedgerOf(input.ledgerDays),
    provenance: {
      schema: EVIDENCE_PACK_SCHEMA,
      engineVersion: REPORT_ENGINE_VERSION,
      templateVersion: MESSAGE_TEMPLATE_VERSION,
      kpiCalcVersion: KPI_CALC_VERSION,
      detectorVersions: [...new Set(findings.map((f) => `${f.detectorId}@${f.detectorVersion}`))].sort(),
      generatedAt: input.generatedAt,
      packHash: '',
    },
  };
  return { ...unhashed, provenance: { ...unhashed.provenance, packHash: computePackHash(unhashed) } };
}

/** om.report.pack jsonb → 팩. 스키마 표시·해시가 없으면 null (내용 변조는 validateDraft가 해시로 잡는다) */
export function readStoredPack(raw: unknown): EvidencePack | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pack = raw as Partial<EvidencePack>;
  const valid = pack.schema === EVIDENCE_PACK_SCHEMA && typeof pack.provenance?.packHash === 'string' && Array.isArray(pack.findings) && typeof pack.site?.code === 'string' && typeof pack.period?.from === 'number';
  return valid ? (pack as EvidencePack) : null;
}

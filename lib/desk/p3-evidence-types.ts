// P3 탐지기 8종 근거 스냅샷 표시 모델. 순수 타입 모듈 (서버·클라이언트 공용).
// 서버가 p3-evidence.ts(zod)로 jsonb를 이 형태로 읽어 클라이언트 차트에 넘긴다. 예전 스냅샷에 없는 값은 null·빈 배열이다.
import type { CheckView, WindowView } from './evidence-types';
import type { TrendView } from './trend';

/** 같은 조건 비교표 한 줄 (용량 감소·P3 상승 탐지기 공용 모양) */
export interface MatchedBinView {
  readonly key: string;
  /** '450~500 kW · 55~60 °C' */
  readonly label: string;
  readonly nRef: number;
  readonly nCur: number;
  readonly medRef: number | null;
  readonly medCur: number | null;
  readonly ratio: number | null;
  readonly used: boolean;
  readonly refFrom: number | null;
  readonly refTo: number | null;
  readonly excluded: string | null;
}

export type RiseDetectorId = 'el.sec_rise' | 'comp.sec_rise' | 'fc.blower_wear' | 'ess.resistance_growth';

/** el.sec_rise · comp.sec_rise · fc.blower_wear · ess.resistance_growth: 같은 조건 bin 비교 + 추세 */
export interface RiseEvidence {
  readonly kind: 'rise';
  readonly detectorId: RiseDetectorId;
  /** 비교 지표 이름 ('계통측 시스템 비에너지') */
  readonly subject: string;
  readonly levelUnit: string;
  readonly levelDigits: number;
  /** 비교표 첫 열 머리글 ('조건 (AC 전력 · 스택 온도)') */
  readonly conditionHeader: string;
  /** 표본 세는 단위 ('구간' · '회') */
  readonly countWord: string;
  readonly bins: readonly MatchedBinView[];
  readonly reference: WindowView;
  readonly recent: WindowView;
  readonly risePct: number | null;
  readonly ciLowPct: number | null;
  readonly ciHighPct: number | null;
  readonly trend: TrendView | null;
  /** 비교 규칙 메모 (운전 조건 기준·break-in·샘플 주기 등) */
  readonly notes: readonly string[];
  readonly checks: readonly CheckView[];
}

export interface TankHoldView {
  readonly role: 'reference' | 'recent';
  readonly start: number;
  readonly hours: number | null;
  readonly lossKgPerDay: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly tMeanC: number | null;
  readonly tRateCPerDay: number | null;
  readonly pMeanBar: number | null;
}

export interface TankCurvePoint {
  readonly ts: number;
  readonly pBar: number | null;
  readonly tC: number | null;
  readonly massKg: number | null;
}

/** tank.static_leak: 정지 보유 구간 온도 보정 질량 기울기 */
export interface TankLeakEvidence {
  readonly kind: 'tank_leak';
  /** 'lemmon2008' · 'abel_noble' */
  readonly eosModel: string | null;
  readonly volumeM3: number | null;
  readonly leakKgPerDay: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly pctPerDay: number | null;
  readonly noiseSigma: number | null;
  readonly zSigma: number | null;
  readonly thresholdKgPerDay: number | null;
  /** 검정 통계량의 표준오차 [kg/일] (옛 스냅샷에는 없다) */
  readonly seKgPerDay: number | null;
  readonly biasKgPerDay: number | null;
  readonly safetyCategory: boolean;
  readonly safetyKgPerDay: number | null;
  readonly holds: readonly TankHoldView[];
  readonly representative: { readonly start: number; readonly end: number; readonly points: readonly TankCurvePoint[] } | null;
  readonly checks: readonly CheckView[];
}

export interface LedgerDayView {
  /** KST 'YYYY-MM-DD' */
  readonly date: string;
  readonly produced: number | null;
  /** 예전 스냅샷에는 없음 (null) */
  readonly fcConsumed: number | null;
  readonly storedDelta: number | null;
  readonly ventedEst: number | null;
  readonly residual: number | null;
  readonly residualPct: number | null;
  readonly completeness: number | null;
}

/** h2chain.mass_balance_gap: 일 수소 원장 잔차율 + CUSUM */
export interface MassBalanceEvidence {
  readonly kind: 'mass_balance';
  readonly reference: { readonly days: number; readonly from: number | null; readonly medianPct: number | null; readonly sigmaPct: number | null };
  readonly recent: { readonly days: number; readonly from: number | null; readonly medianPct: number | null; readonly medianKg: number | null };
  readonly cusum: {
    readonly direction: 'up' | 'down' | null;
    readonly alarmDay: string | null;
    readonly changeStartDay: string | null;
    readonly k: number | null;
    readonly h: number | null;
    /** 경보 방향 누적합 경로 (예전 스냅샷에는 없음) */
    readonly points: readonly { readonly date: string; readonly s: number }[];
  };
  readonly days: readonly LedgerDayView[];
  /** 일 행에 연료전지 소비·저장 증감·배기 값이 있는가 (예전 스냅샷은 false) */
  readonly hasBalanceTerms: boolean;
  readonly checks: readonly CheckView[];
}

export interface SoilingSegmentView {
  readonly from: string;
  readonly to: string;
  readonly clearDays: number;
  readonly ratePctPerDay: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  /** 구간 기울기선 두 끝점 (예전 스냅샷에는 없음) */
  readonly line: readonly { readonly date: string; readonly pi: number }[] | null;
}

/** pv.soiling_rate: 맑은 날 성능지수 구간 기울기 */
export interface SoilingEvidence {
  readonly kind: 'soiling';
  readonly ratePctPerDay: number | null;
  readonly gammaPerC: number | null;
  readonly piPoints: readonly { readonly date: string; readonly pi: number }[];
  readonly currentLine: readonly { readonly date: string; readonly pi: number }[] | null;
  readonly segments: readonly SoilingSegmentView[];
  readonly resets: readonly { readonly date: string; readonly kind: string; readonly recoveryPct: number | null }[];
  readonly economics: { readonly cumulativeLossKwh: number | null; readonly dailyLossKwh: number | null; readonly lossValueKrw: number | null };
  readonly smpKrwPerKwh: number | null;
  readonly cleaningCostKrw: number | null;
  /** 제외 사유별 인버터·일 수 (없으면 빈 목록) */
  readonly exclusions: readonly (readonly [code: string, count: number])[];
  readonly checks: readonly CheckView[];
}

/** inv.thermal_derating: 동종 대비 방열판 고온 저감 */
export interface ThermalEvidence {
  readonly kind: 'thermal';
  readonly derateStartC: number | null;
  readonly marginC: number | null;
  readonly gapPct: number | null;
  readonly days: readonly { readonly date: string; readonly derateH: number | null; readonly lossKwh: number | null; readonly ambientMaxC: number | null }[];
  readonly ambientBins: readonly { readonly binC: number; readonly nRef: number; readonly nCur: number; readonly refDerateH: number | null; readonly curDerateH: number | null }[];
  readonly binShift: { readonly ref: number; readonly cur: number } | null;
  readonly representativeDay: { readonly date: string; readonly unit: string; readonly points: readonly { readonly ts: number; readonly own: number | null; readonly peer: number | null; readonly heatsinkC: number | null }[] } | null;
  readonly checks: readonly CheckView[];
}

export type GapyeongEvidenceDetectorId = 'prv.seat_leak' | 'hx.fouling' | 'o2.purity_drift';

/**
 * 가평 구성 탐지기 3종 공용 표시 모델: 기준 구간 값 → 최근 구간 값 (+ 한계선까지 남은 여유).
 * 셋 다 '같은 조건에서 어떤 값이 얼마나 움직였는가'라는 뼈대가 같아 한 타입으로 읽는다.
 */
export interface GapyeongEvidence {
  readonly kind: 'gapyeong';
  readonly detectorId: GapyeongEvidenceDetectorId;
  /** 비교 지표 이름 ('접근온도 (1차측 입구 − 2차측 출구)') */
  readonly subject: string;
  readonly unit: string;
  readonly referenceCount: number;
  readonly recentCount: number;
  readonly referenceLevel: number | null;
  readonly recentLevel: number | null;
  /** 한계선 (압축금지 2 vol% · 크리프 경고 기준). 없으면 null */
  readonly limit: number | null;
  readonly limitLabel: string | null;
  /** 한계선까지 남은 여유 */
  readonly margin: number | null;
  readonly extra: {
    readonly alarmHolds: number | null;
    readonly minAlarmHolds: number | null;
    readonly leakNlPerMin: number | null;
    readonly downstreamVolumeM3: number | null;
    readonly uaDropPct: number | null;
    readonly marginPctPoints: number | null;
  };
  /** 날짜별 값 (추세 차트) */
  readonly points: readonly { readonly date: string; readonly value: number | null }[];
  readonly note: string | null;
  readonly checks: readonly CheckView[];
}

export type P3EvidenceView = RiseEvidence | TankLeakEvidence | MassBalanceEvidence | SoilingEvidence | ThermalEvidence | GapyeongEvidence;

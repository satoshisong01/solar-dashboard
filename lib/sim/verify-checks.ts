// 적재 검증 판정 (verify:ingest). DB에서 관측한 값과 sim:backfill이 기록한 기대치를 비교하는 순수 함수만 둔다.
import type { SiteTotals } from './manifest';

export interface UnmappedObservation {
  readonly sourceKey: string;
  readonly sampleCount: number;
}

export interface SiteObservation {
  /** 적재 샘플 시각 범위 안의 om.measurement 행 수 */
  readonly samples: number;
  readonly clockSuspect: number;
  readonly late: number;
  /** is_safety 이벤트 수 (같은 범위) */
  readonly safetyEvents: number;
  readonly unmapped: readonly UnmappedObservation[];
}

export interface RollupObservation {
  /** 원시 재집계와 m_1h를 FULL JOIN한 (포인트, 시간) 수 */
  readonly buckets: number;
  /** 원시는 있는데 m_1h가 없는 버킷 */
  readonly missingRollups: number;
  /** m_1h는 있는데 원시가 없는 버킷 */
  readonly orphanRollups: number;
  /** n·n_good·min·max·first·last 중 하나라도 다른 버킷 */
  readonly exactMismatches: number;
  /** avg·sum이 비트 단위로 다른 버킷 (부동소수 합산 순서 차이) */
  readonly floatBitDiffs: number;
  /** avg·sum 차이가 허용 오차(상대 1e-9)를 넘는 버킷 */
  readonly floatMismatches: number;
  readonly maxScaledDiff: number;
  /** 모두 처리한 뒤에도 남은 dirty 버킷 */
  readonly dirtyRemaining: number;
}

export interface IngestObservation {
  readonly sites: Readonly<Record<string, SiteObservation>>;
  readonly rollup: RollupObservation;
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: 'a' | 'b' | 'c' | 'd' | 'e';
  readonly title: string;
  readonly status: CheckStatus;
  readonly details: readonly string[];
}

export interface VerifyExpectation {
  readonly sites: Readonly<Record<string, SiteTotals>>;
  /** 사이트 코드 → 일부러 매핑하지 않은 원본 태그 */
  readonly intendedUnmapped: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_SITE: SiteObservation = { samples: 0, clockSuspect: 0, late: 0, safetyEvents: 0, unmapped: [] };
const fmt = (n: number) => n.toLocaleString('en-US');
const statusOf = (failed: boolean): CheckStatus => (failed ? 'fail' : 'pass');

function siteEntries(expected: VerifyExpectation, observed: IngestObservation) {
  return Object.entries(expected.sites).map(([code, totals]) => ({ code, totals, seen: observed.sites[code] ?? EMPTY_SITE }));
}

function checkSampleCounts(expected: VerifyExpectation, observed: IngestObservation): CheckResult {
  const rows = siteEntries(expected, observed);
  const details = rows.map(({ code, totals, seen }) => `${code}: 기대 ${fmt(totals.expectedSamples)} · 실제 ${fmt(seen.samples)}${totals.expectedSamples === seen.samples ? '' : ' ← 불일치'}`);
  const expectedTotal = rows.reduce((sum, row) => sum + row.totals.expectedSamples, 0);
  const actualTotal = rows.reduce((sum, row) => sum + row.seen.samples, 0);
  return {
    id: 'a',
    title: '포인트별 measurement 행 수 합 = 기대 고유 샘플 수 (미매핑 제외)',
    status: statusOf(rows.some((row) => row.totals.expectedSamples !== row.seen.samples) || expectedTotal === 0),
    details: [...details, `합계: 기대 ${fmt(expectedTotal)} · 실제 ${fmt(actualTotal)}`],
  };
}

function checkRollup({ rollup }: IngestObservation): CheckResult {
  const failed = rollup.dirtyRemaining > 0 || rollup.missingRollups > 0 || rollup.orphanRollups > 0 || rollup.exactMismatches > 0 || rollup.floatMismatches > 0 || rollup.buckets === 0;
  return {
    id: 'b',
    title: 'dirty 전부 처리 후 m_1h = 원시 전체 재집계',
    status: statusOf(failed),
    details: [
      `비교한 (포인트, 시간) ${fmt(rollup.buckets)} · 남은 dirty ${fmt(rollup.dirtyRemaining)}`,
      `m_1h 누락 ${fmt(rollup.missingRollups)} · 원시 없는 m_1h ${fmt(rollup.orphanRollups)} · n/n_good/min/max/first/last 불일치 ${fmt(rollup.exactMismatches)}`,
      `avg·sum 허용오차 초과 ${fmt(rollup.floatMismatches)} · 비트 단위 차이 ${fmt(rollup.floatBitDiffs)} (최대 상대 차이 ${rollup.maxScaledDiff.toExponential(2)})`,
    ],
  };
}

function checkUnmapped(expected: VerifyExpectation, observed: IngestObservation): CheckResult {
  const rows = siteEntries(expected, observed).filter(({ code }) => (expected.intendedUnmapped.get(code) ?? []).length > 0 || (observed.sites[code]?.unmapped.length ?? 0) > 0);
  if (rows.length === 0) return { id: 'c', title: 'unmapped_source에 의도한 태그', status: 'skip', details: ['적재한 사이트에 미매핑 예정 태그가 없습니다'] };

  const problems: string[] = [];
  const details = rows.map(({ code, totals, seen }) => {
    const intended = expected.intendedUnmapped.get(code) ?? [];
    const byKey = new Map(seen.unmapped.map((u) => [u.sourceKey, u.sampleCount]));
    intended.filter((key) => !((byKey.get(key) ?? 0) > 0)).forEach((key) => problems.push(`${code} ${key} 없음`));
    seen.unmapped.filter((u) => !intended.includes(u.sourceKey)).forEach((u) => problems.push(`${code} 의도하지 않은 태그 ${u.sourceKey}`));
    const counted = intended.reduce((sum, key) => sum + (byKey.get(key) ?? 0), 0);
    if (counted < totals.expectedUnmappedSamples) problems.push(`${code} 미매핑 샘플 수 ${fmt(counted)} < 기대 ${fmt(totals.expectedUnmappedSamples)}`);
    return `${code}: ${seen.unmapped.map((u) => `${u.sourceKey}(${fmt(u.sampleCount)})`).join(', ') || '없음'} · 기대 샘플 ${fmt(totals.expectedUnmappedSamples)}`;
  });
  return { id: 'c', title: 'unmapped_source에 의도한 태그', status: statusOf(problems.length > 0), details: [...details, ...problems] };
}

function checkSafety(expected: VerifyExpectation, observed: IngestObservation): CheckResult {
  const rows = siteEntries(expected, observed);
  const expectedTotal = rows.reduce((sum, row) => sum + row.totals.criticalEvents, 0);
  const actualTotal = rows.reduce((sum, row) => sum + row.seen.safetyEvents, 0);
  const details = rows.map(({ code, totals, seen }) => `${code}: critical 보냄 ${fmt(totals.criticalEvents)} · is_safety 기록 ${fmt(seen.safetyEvents)}`);
  if (expectedTotal === 0) return { id: 'd', title: 'event_log 안전 이벤트 1건 이상', status: 'skip', details: [...details, '시나리오에 안전 경보가 없습니다'] };
  const failed = actualTotal < 1 || rows.some((row) => row.seen.safetyEvents < row.totals.criticalEvents);
  return { id: 'd', title: 'event_log 안전 이벤트 1건 이상', status: statusOf(failed), details };
}

function checkQualityBits(expected: VerifyExpectation, observed: IngestObservation): CheckResult {
  const rows = siteEntries(expected, observed);
  const lateTotal = rows.reduce((sum, row) => sum + row.seen.late, 0);
  const suspectMismatch = rows.some((row) => row.seen.clockSuspect !== row.totals.clockSuspectSamples);
  const details = rows.map(
    ({ code, totals, seen }) =>
      `${code}: CLOCK_SUSPECT 기대 ${fmt(totals.clockSuspectSamples)} · 실제 ${fmt(seen.clockSuspect)}${seen.clockSuspect === totals.clockSuspectSamples ? '' : ' ← 불일치'} / LATE ${fmt(seen.late)}`,
  );
  const suspectTotal = rows.reduce((sum, row) => sum + row.totals.clockSuspectSamples, 0);
  return {
    id: 'e',
    title: 'CLOCK_SUSPECT·LATE 비트 발생',
    status: statusOf(suspectMismatch || lateTotal === 0),
    details: [...details, ...(suspectTotal === 0 ? ['시나리오에 시계 오차가 없어 CLOCK_SUSPECT 0건이 기대값입니다'] : []), ...(lateTotal === 0 ? ['LATE 비트가 한 건도 없습니다'] : [])],
  };
}

export function evaluateIngest(expected: VerifyExpectation, observed: IngestObservation): readonly CheckResult[] {
  return [
    checkSampleCounts(expected, observed),
    checkRollup(observed),
    checkUnmapped(expected, observed),
    checkSafety(expected, observed),
    checkQualityBits(expected, observed),
  ];
}

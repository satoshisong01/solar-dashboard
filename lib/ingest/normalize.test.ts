import { describe, expect, it } from 'vitest';
import type { IngestEnvelope, IngestEvent, IngestSeries } from './envelope';
import {
  normalizeEvents,
  normalizeSamples,
  sourceKeyPrefixes,
  type EventContext,
  type NormalizeOptions,
  type PointMapping,
} from './normalize';
import { QUALITY } from './quality';

const RECEIVED_AT = Date.UTC(2026, 8, 14, 3, 5, 0);
const MINUTE = 60_000;

const mapping = (pointId: number, overrides: Partial<PointMapping> = {}): PointMapping => ({
  pointId,
  scale: 1,
  valueOffset: 0,
  hardMin: null,
  hardMax: null,
  ...overrides,
});

const POINTS: ReadonlyMap<string, PointMapping> = new Map([
  ['ESS1/RACK01/I_DC', mapping(1, { hardMin: -3000, hardMax: 3000 })],
  ['ESS1/RACK01/V_CELL_MAX', mapping(2, { scale: 0.001, hardMin: -2, hardMax: 5 })],
  ['WX1/T_MOD', mapping(3, { valueOffset: -273.15 })],
]);

type EnvelopePart = Pick<IngestEnvelope, 'series' | 'sent_at' | 'clock'>;

function envelope(series: readonly IngestSeries[], overrides: Partial<EnvelopePart> = {}): EnvelopePart {
  return {
    sent_at: new Date(RECEIVED_AT).toISOString(),
    clock: { ntp_synced: true, ntp_offset_ms: 3 },
    series: [...series],
    ...overrides,
  };
}

function normalize(part: EnvelopePart, overrides: Partial<NormalizeOptions> = {}) {
  return normalizeSamples(part, { pointsBySource: POINTS, receivedAtMs: RECEIVED_AT, ...overrides });
}

const regular = (src: string, t0: number, v: (number | null)[], q?: number[]): IngestSeries => ({ src, unit: '', t0, dt: MINUTE, v, q });

describe('normalizeSamples', () => {
  it('t0+dt와 ts를 샘플로 펼치고 scale·offset으로 정규 단위로 바꾼다', () => {
    const t0 = RECEIVED_AT - 10 * MINUTE;
    const result = normalize(
      envelope([
        regular('ESS1/RACK01/V_CELL_MAX', t0, [3312, 3320]),
        { src: 'WX1/T_MOD', unit: 'K', ts: [t0 + 5_000, t0 + 65_000], v: [300, 273.15] },
      ]),
    );

    expect(result.samples).toEqual([
      { pointId: 2, tsMs: t0, value: 3312 * 0.001, quality: 0 },
      { pointId: 2, tsMs: t0 + MINUTE, value: 3320 * 0.001, quality: 0 },
      { pointId: 3, tsMs: t0 + 5_000, value: 300 - 273.15, quality: 0 },
      { pointId: 3, tsMs: t0 + 65_000, value: 0, quality: 0 },
    ]);
    expect(result.stats).toEqual({ total: 4, candidates: 4, rejected: 0, unmapped: 0, missing: 0 });
  });

  it('hard 범위 밖이면 HARD_RANGE, 장치 품질 코드가 0이 아니면 DEVICE_BAD (값은 저장한다)', () => {
    const t0 = RECEIVED_AT - 10 * MINUTE;
    const result = normalize(envelope([regular('ESS1/RACK01/V_CELL_MAX', t0, [5000, 5001, -2001, 3300], [0, 0, 0, 7])]));

    expect(result.samples.map((sample) => sample.quality)).toEqual([0, QUALITY.HARD_RANGE, QUALITY.HARD_RANGE, QUALITY.DEVICE_BAD]);
  });

  it('null은 저장하지 않고 missing으로만 센다', () => {
    const result = normalize(envelope([regular('ESS1/RACK01/I_DC', RECEIVED_AT - 5 * MINUTE, [1, null, 3, null])]));

    expect(result.samples.map((sample) => sample.value)).toEqual([1, 3]);
    expect(result.stats).toMatchObject({ total: 4, candidates: 2, missing: 2 });
  });

  it('수신 시각보다 5분 넘게 미래이거나 2000년 이전인 샘플은 거부한다 (정확히 +5분은 받는다)', () => {
    const result = normalize(
      envelope([
        { src: 'ESS1/RACK01/I_DC', unit: 'A', ts: [RECEIVED_AT + 5 * MINUTE, RECEIVED_AT + 5 * MINUTE + 1, Date.UTC(1999, 11, 31)], v: [1, 2, 3] },
      ]),
    );

    expect(result.samples.map((sample) => sample.value)).toEqual([1]);
    expect(result.stats).toMatchObject({ total: 3, candidates: 1, rejected: 2 });
  });

  it('수신 시각보다 1시간 이상 과거인 샘플은 LATE', () => {
    const hour = 60 * MINUTE;
    const result = normalize(
      envelope([{ src: 'ESS1/RACK01/I_DC', unit: 'A', ts: [RECEIVED_AT - hour, RECEIVED_AT - hour + 1], v: [1, 2] }]),
    );

    expect(result.samples.map((sample) => sample.quality)).toEqual([QUALITY.LATE, 0]);
  });

  it.each([
    ['NTP 미동기', { clock: { ntp_synced: false, ntp_offset_ms: 0 } }, true],
    ['게이트웨이 시계 +121초', { sent_at: new Date(RECEIVED_AT + 121_000).toISOString() }, true],
    ['게이트웨이 시계 −121초', { sent_at: new Date(RECEIVED_AT - 121_000).toISOString() }, true],
    ['게이트웨이 시계 +120초', { sent_at: new Date(RECEIVED_AT + 120_000).toISOString() }, false],
  ])('%s → CLOCK_SUSPECT=%s', (_label, overrides, suspect) => {
    const result = normalize(envelope([regular('ESS1/RACK01/I_DC', RECEIVED_AT - MINUTE, [1])], overrides));

    expect(result.clockSuspect).toBe(suspect);
    expect(result.samples[0]?.quality).toBe(suspect ? QUALITY.CLOCK_SUSPECT : 0);
  });

  it('skewMs는 sent_at − 수신 시각이다', () => {
    const result = normalize(envelope([], { sent_at: new Date(RECEIVED_AT + 200_000).toISOString() }));

    expect(result.skewMs).toBe(200_000);
  });

  it('매핑되지 않은 태그는 태그별로 합쳐 미매핑으로 분리한다', () => {
    const t0 = RECEIVED_AT - 10 * MINUTE;
    const result = normalize(
      envelope([
        { src: 'COMP1/VIB_RMS', unit: 'mm/s', t0, dt: MINUTE, v: [1.2, null, 1.4] },
        regular('ESS1/RACK01/I_DC', t0, [10]),
        { src: 'COMP1/VIB_RMS', unit: 'mm/s', ts: [t0 + 5 * MINUTE], v: [1.5] },
      ]),
    );

    expect(result.unmapped).toEqual([{ sourceKey: 'COMP1/VIB_RMS', unit: 'mm/s', sampleCount: 4 }]);
    expect(result.stats).toEqual({ total: 5, candidates: 1, rejected: 0, unmapped: 4, missing: 0 });
  });

  it('재처리면 모든 샘플에 REPROCESSED를 더한다', () => {
    const result = normalize(
      envelope([regular('ESS1/RACK01/V_CELL_MAX', RECEIVED_AT - 2 * 60 * MINUTE, [9000])], { clock: { ntp_synced: false, ntp_offset_ms: 0 } }),
      { reprocessed: true },
    );

    expect(result.samples[0]?.quality).toBe(QUALITY.REPROCESSED | QUALITY.CLOCK_SUSPECT | QUALITY.HARD_RANGE | QUALITY.LATE);
  });
});

describe('normalizeEvents', () => {
  const context: EventContext = {
    assetsByCode: new Map([
      ['ESS1', { assetId: 10, safetyEventCodes: ['FIRE_ALARM', 'ESD'] }],
      ['ESS1/RACK01', { assetId: 11, safetyEventCodes: ['CELL_OVERTEMP'] }],
      ['GD1', { assetId: 20, safetyEventCodes: ['H2_LEAK_L1', 'H2_LEAK_L2'] }],
    ]),
    allSafetyEventCodes: new Set(['FIRE_ALARM', 'ESD', 'CELL_OVERTEMP', 'H2_LEAK_L1', 'H2_LEAK_L2']),
  };
  const event = (src: string, code: string, severity: IngestEvent['severity'], text?: string): IngestEvent => ({
    src,
    ts: RECEIVED_AT,
    code,
    severity,
    text,
  });

  it('가장 긴 설비 코드 접두어로 설비를 찾는다', () => {
    expect(sourceKeyPrefixes('ESS1/RACK01/BMS')).toEqual(['ESS1/RACK01/BMS', 'ESS1/RACK01', 'ESS1']);

    const [rack, plant, unknown] = normalizeEvents(
      [event('ESS1/RACK01/BMS', 'W101', 'minor', '셀 편차'), event('ESS1/PCS_X', 'W1', 'info'), event('XX/Y', 'W2', 'info')],
      context,
    );

    expect(rack).toEqual({ sourceKey: 'ESS1/RACK01/BMS', tsMs: RECEIVED_AT, code: 'W101', severity: 'minor', text: '셀 편차', assetId: 11, isSafety: false });
    expect(plant).toMatchObject({ assetId: 10, text: null });
    expect(unknown).toMatchObject({ assetId: null, isSafety: false });
  });

  it('설비와 상위 설비 종류의 안전 코드면 severity와 무관하게 안전 이벤트다', () => {
    const [own, ancestor, otherClass] = normalizeEvents(
      [event('ESS1/RACK01/T', 'CELL_OVERTEMP', 'major'), event('ESS1/RACK01/FIRE', 'FIRE_ALARM', 'info'), event('ESS1/RACK01/X', 'H2_LEAK_L1', 'major')],
      context,
    );

    expect([own.isSafety, ancestor.isSafety, otherClass.isSafety]).toEqual([true, true, false]);
  });

  it('critical은 등록되지 않은 코드여도 안전 이벤트다', () => {
    const [known, unknownAsset] = normalizeEvents([event('GD1/ALARM', 'H2_ALARM_X', 'critical'), event('NOPE/1', 'ANY', 'critical')], context);

    expect(known).toMatchObject({ assetId: 20, isSafety: true });
    expect(unknownAsset).toMatchObject({ assetId: null, isSafety: true });
  });

  it('설비를 찾지 못하면 전체 안전 코드 목록으로 판정한다', () => {
    const [result] = normalizeEvents([event('H2BANK9/DET', 'H2_LEAK_L2', 'major')], context);

    expect(result).toMatchObject({ assetId: null, isSafety: true });
  });
});

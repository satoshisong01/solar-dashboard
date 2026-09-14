import { describe, expect, it } from 'vitest';
import { MAX_SAMPLES_PER_BATCH, countSamples, parseEnvelope, sampleTimestamps, type IngestEnvelopeInput } from './envelope';

/** 설계 §5.1 예시 봉투 */
function exampleEnvelope(): IngestEnvelopeInput {
  return {
    schema: 'om.ingest.v1',
    gateway: 'GW-SIMB-01',
    batch_id: '01923f6e-7c1a-7b1e-9a4e-2f1c3d5e7a90',
    seq: 182340,
    sent_at: '2026-09-14T03:05:00.120Z',
    clock: { ntp_synced: true, ntp_offset_ms: -12 },
    series: [
      { src: 'ESS1/RACK03/I_DC', unit: 'A', t0: 1757818800000, dt: 10000, v: [55.1, 55.3, null, 54.9], q: [0, 0, 1, 0] },
      { src: 'ESS1/RACK03/SOC', unit: '%', ts: [1757818805000, 1757818866000], v: [41.2, 41.6] },
    ],
    events: [
      { src: 'PCS1/FAULT', ts: 1757818930000, code: 'E023', severity: 'major', text: 'DC overvoltage' },
      { src: 'H2BANK1/GAS_DET2', ts: 1757818990000, code: 'H2_ALARM_L1', severity: 'critical' },
    ],
  };
}

function issuesOf(value: unknown): readonly string[] {
  const result = parseEnvelope(value);
  if (result.ok) throw new Error('검증에 실패해야 합니다');
  return result.issues;
}

describe('parseEnvelope', () => {
  it('설계 예시 봉투를 통과시킨다', () => {
    const result = parseEnvelope(exampleEnvelope());

    expect(result.ok).toBe(true);
  });

  it('모르는 선택 필드는 거부하지 않고 버린다 (v1 호환)', () => {
    const result = parseEnvelope({ ...exampleEnvelope(), firmware: '2.1.0', meta: { site: 'SIM-B' } });

    expect(result.ok && 'firmware' in result.envelope).toBe(false);
    expect(result.ok && result.envelope.meta).toEqual({ site: 'SIM-B' });
  });

  it.each([
    ['schema가 다르면', { schema: 'om.ingest.v2' }, /^schema:/],
    ['batch_id가 uuid가 아니면', { batch_id: 'batch-1' }, /^batch_id:/],
    ['seq가 음수면', { seq: -1 }, /^seq:/],
    ['sent_at이 ISO 시각이 아니면', { sent_at: '2026-09-14 03:05' }, /^sent_at:/],
    ['clock이 없으면', { clock: undefined }, /^clock:/],
    ['events가 없으면', { events: undefined }, /^events:/],
  ])('%s 거부한다', (_label, patch, pattern) => {
    expect(issuesOf({ ...exampleEnvelope(), ...patch })).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it.each([
    ['t0+dt와 ts를 함께 보내면', { t0: 1, dt: 1000, ts: [1, 2], v: [1, 2] }, /하나만/],
    ['t0만 있고 dt가 없으면', { t0: 1757818800000, v: [1, 2] }, /t0와 dt/],
    ['시각 정보가 없으면', { v: [1, 2] }, /t0\+dt 또는 ts/],
    ['ts 길이가 v와 다르면', { ts: [1757818800000], v: [1, 2] }, /ts 길이\(1\)/],
    ['q 길이가 v와 다르면', { t0: 1757818800000, dt: 1000, v: [1, 2], q: [0] }, /q 길이\(1\)/],
    ['v에 숫자·null 외 값이 있으면', { t0: 1757818800000, dt: 1000, v: [1, '2'] }, /series\.0\.v\.1/],
    ['v가 비어 있으면', { t0: 1757818800000, dt: 1000, v: [] }, /series\.0\.v/],
    ['dt가 0이면', { t0: 1757818800000, dt: 0, v: [1] }, /series\.0\.dt/],
  ])('시계열: %s 거부한다', (_label, series, pattern) => {
    const envelope = { ...exampleEnvelope(), series: [{ src: 'A/B', unit: 'A', ...series }] };

    expect(issuesOf(envelope)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it('필드 타입 오류가 있어도 예외 없이 오류 목록을 돌려준다', () => {
    const envelope = { ...exampleEnvelope(), series: [{ src: 'A/B', unit: 'A', t0: 1 }] };

    expect(() => parseEnvelope(envelope)).not.toThrow();
    expect(issuesOf(envelope).length).toBeGreaterThan(0);
  });

  it('이벤트 severity는 info/minor/major/critical만 받는다', () => {
    const envelope = { ...exampleEnvelope(), events: [{ src: 'X', ts: 1757818930000, code: 'E1', severity: 'fatal' }] };

    expect(issuesOf(envelope)).toEqual(expect.arrayContaining([expect.stringMatching(/^events\.0\.severity:/)]));
  });

  it(`배치 샘플 수가 ${MAX_SAMPLES_PER_BATCH}개를 넘으면 거부하고, 딱 상한이면 받는다`, () => {
    const series = (count: number) => [
      { src: 'A/1', unit: 'A', t0: 1757818800000, dt: 1000, v: new Array<number>(count - 1).fill(1) },
      { src: 'A/2', unit: 'A', t0: 1757818800000, dt: 1000, v: [1] },
    ];

    expect(parseEnvelope({ ...exampleEnvelope(), series: series(MAX_SAMPLES_PER_BATCH) }).ok).toBe(true);
    expect(issuesOf({ ...exampleEnvelope(), series: series(MAX_SAMPLES_PER_BATCH + 1) })).toEqual([
      expect.stringMatching(/^series: 배치 샘플 수\(20001\)/),
    ]);
  });
});

describe('sampleTimestamps / countSamples', () => {
  it('정주기는 t0 + dt × i, 비정주기는 ts를 그대로 쓴다', () => {
    const result = parseEnvelope(exampleEnvelope());
    if (!result.ok) throw new Error('예시 봉투가 통과해야 합니다');
    const [regular, irregular] = result.envelope.series;

    expect(sampleTimestamps(regular)).toEqual([1757818800000, 1757818810000, 1757818820000, 1757818830000]);
    expect(sampleTimestamps(irregular)).toEqual([1757818805000, 1757818866000]);
    expect(countSamples(result.envelope.series)).toBe(6);
  });
});

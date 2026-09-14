import { describe, expect, it } from 'vitest';
import { buildEnvelope, buildSeries, INGEST_SCHEMA, uuidV5, type EnvelopeInput, type EnvelopeSample } from './envelope';

const T0 = Date.parse('2026-09-14T03:00:00Z');
const sample = (sourceKey: string, i: number, periodS = 60, value = i): EnvelopeSample => ({ sourceKey, unit: 'kW', periodS, ts: T0 + i * periodS * 1000, value });

const input = (extra: Partial<EnvelopeInput> = {}): EnvelopeInput => ({
  seed: 7,
  gateway: 'GW-SIMB-01',
  seq: 590_000_100,
  sentAtMs: T0 + 300_500,
  clock: { ntp_synced: true, ntp_offset_ms: -3 },
  samples: [sample('PV1/INV01/P_AC', 0), sample('PV1/INV01/P_AC', 1), sample('WX1/POA', 0, 300)],
  events: [{ src: 'ELZ1/EVENT', ts: T0 + 60_000, code: 'START', severity: 'info', text: '수전해 기동' }],
  ...extra,
});

describe('uuidV5', () => {
  it('RFC 4122 표준 벡터와 같다 (DNS 네임스페이스, www.example.com)', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('버전 5·variant 비트를 가진 UUID 형식이다', () => {
    expect(uuidV5('anything')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('buildSeries', () => {
  it('주기 간격으로 이어진 샘플은 t0+dt, 빈틈이 있으면 ts[]로 만든다', () => {
    const series = buildSeries([sample('A', 0), sample('B', 0, 300), sample('A', 1), sample('A', 2), sample('C', 0), sample('C', 2)]);

    expect(series).toEqual([
      { src: 'A', unit: 'kW', t0: T0, dt: 60_000, v: [0, 1, 2] },
      { src: 'B', unit: 'kW', t0: T0, dt: 300_000, v: [0] },
      { src: 'C', unit: 'kW', ts: [T0, T0 + 120_000], v: [0, 2] },
    ]);
  });
});

describe('buildEnvelope', () => {
  it('om.ingest.v1 필드를 채운다', () => {
    const envelope = buildEnvelope(input());

    expect(envelope).toMatchObject({
      schema: INGEST_SCHEMA,
      gateway: 'GW-SIMB-01',
      seq: 590_000_100,
      sent_at: new Date(T0 + 300_500).toISOString(),
      clock: { ntp_synced: true, ntp_offset_ms: -3 },
      events: [{ src: 'ELZ1/EVENT', code: 'START', severity: 'info', text: '수전해 기동' }],
    });
    expect(envelope.series).toHaveLength(2);
  });

  it('같은 입력이면 같은 batch_id, 본문·seq·시드가 다르면 다른 batch_id', () => {
    const base = buildEnvelope(input()).batch_id;

    expect(buildEnvelope(input()).batch_id).toBe(base);
    expect(buildEnvelope(input({ samples: [sample('PV1/INV01/P_AC', 0, 60, 99)] })).batch_id).not.toBe(base);
    expect(buildEnvelope(input({ seq: 590_000_101 })).batch_id).not.toBe(base);
    expect(buildEnvelope(input({ seed: 8 })).batch_id).not.toBe(base);
  });

  it('text가 없는 이벤트에는 text 키를 넣지 않는다', () => {
    const envelope = buildEnvelope(input({ events: [{ src: 'PV1/INV01/EVENT', ts: T0, code: 'INV_TRIP', severity: 'major' }] }));

    expect(Object.keys(envelope.events[0] ?? {})).toEqual(['src', 'ts', 'code', 'severity']);
  });
});

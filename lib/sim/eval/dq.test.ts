import { describe, expect, it } from 'vitest';
import { dqGapFlatline } from '@/lib/analytics/detectors/dq-gap-flatline';
import { memoryDqInput } from '@/lib/analytics/dq/summary';
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/analytics/types';
import { detectorPointFilter, simulateMemory } from '../memory';
import { deriveRng } from '../rng';
import { evalSite } from './assets';
import { DQ_WINDOW_DAYS, dqAssetCount, dqFindingsAt, prepareDq } from './dq';

const FROM = Date.parse('2026-04-01T00:00:00+09:00');

describe('데이터 품질 메모리 평가', () => {
  it('압축 요약으로 만든 점검 창 결과 = 원시로 바로 만든 요약 결과 (결측 6시간·일사계 고착 8시간·짧은 결측 1시간)', () => {
    const scenarios = [
      { kind: 'dq.sample_loss', site: 'SIM-A', sourceKey: 'WX1/T_AMB', start: FROM + 2 * MS_PER_DAY + 10 * MS_PER_HOUR, durationS: 6 * 3600 },
      { kind: 'dq.stuck_sensor', site: 'SIM-A', sourceKey: 'WX1/POA', start: FROM + 5 * MS_PER_DAY + 9 * MS_PER_HOUR, durationS: 8 * 3600 },
      { kind: 'dq.sample_loss', site: 'SIM-A', sourceKey: 'ESS1/T_ROOM', start: FROM + 6 * MS_PER_DAY + 3.5 * MS_PER_HOUR, durationS: 3600 },
    ] as const;
    const to = FROM + 10 * MS_PER_DAY;
    const memory = simulateMemory({ siteCodes: ['SIM-A'], from: FROM, to, seed: 11, scenarios, pointFilter: detectorPointFilter });
    const site = evalSite('SIM-A');
    const prepared = prepareDq(site, memory.series, { start: FROM, end: to });
    expect(dqAssetCount(prepared)).toBeGreaterThan(5);

    const bySource = new Map([...memory.series.values()].map((s) => [s.sourceKey, s]));
    for (const now of [FROM + 7 * MS_PER_DAY, FROM + 8.5 * MS_PER_DAY, to]) {
      const window = { start: Math.max(FROM, now - DQ_WINDOW_DAYS * MS_PER_DAY), end: now };
      const direct = memoryDqInput(site.siteId, prepared.points.map((p) => ({ meta: p.meta, ts: bySource.get(p.meta.sourceKey)?.ts ?? [], values: bySource.get(p.meta.sourceKey)?.value ?? [] })), window);
      const directResult = dqGapFlatline.detect(direct, { now, rng: deriveRng(11, dqGapFlatline.id, site.siteId), params: {} });
      expect(dqFindingsAt(prepared, site.siteId, FROM, now, 11)).toEqual(directResult.status === 'ok' ? directResult.findings : []);
    }

    const findings = dqFindingsAt(prepared, site.siteId, FROM, FROM + 8.5 * MS_PER_DAY, 11);
    const wx = site.byPath.get('SIM-A/WX1')?.id;
    const room = site.byPath.get('SIM-A/ESS1')?.id;
    const wxFinding = findings.find((f) => f.assetId === wx);
    expect(wxFinding?.title).toBe('데이터 품질: 수신 결측·센서 값 고착');
    expect(wxFinding?.summary).toContain('WX1/POA');
    // 1시간 결측(정시에 걸치지 않음)은 빈 시간 버킷이 없고 완결성도 기준 이상이라 finding이 아니다
    expect(findings.some((f) => f.assetId === room)).toBe(false);
    expect(dqFindingsAt(prepared, site.siteId, FROM, FROM, 11)).toEqual([]);
  }, 60_000);
});

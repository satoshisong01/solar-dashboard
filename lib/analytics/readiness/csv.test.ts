import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/csv/parse';
import { acquisitionCsvRows, csvField, readinessCsvRows, reasonText, toCsvText } from './csv';
import type { ReadinessCell } from './types';

describe('csvField 이스케이프', () => {
  it('쉼표·큰따옴표·줄바꿈은 큰따옴표로 감싸고 "는 ""로', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('cr\r')).toBe('"cr\r"');
  });

  it('수식으로 시작하는 문자열은 앞에 작은따옴표(CSV 인젝션 방지), 숫자·null·비유한수', () => {
    expect(csvField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvField('+82-10')).toBe("'+82-10");
    expect(csvField('-5')).toBe("'-5");
    expect(csvField('@cmd')).toBe("'@cmd");
    expect(csvField('\tx')).toBe("'\tx");
    expect(csvField('=1,2')).toBe(`"'=1,2"`);
    expect(csvField(-5)).toBe('-5');
    expect(csvField(0.25)).toBe('0.25');
    expect(csvField(null)).toBe('');
    expect(csvField(Number.NaN)).toBe('');
  });

  it('toCsvText: BOM + CRLF, 파서로 되읽으면 같은 필드', () => {
    const rows = [['설비 (asset_code)', '사유 (reasons)'], ['ESS1/RACK01', 'batt.soc 완결성 82%, "주의"\n다음 줄'], [1, null]];
    const text = toCsvText(rows);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    const parsed = parseCsv(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.records.map((r) => r.fields)).toEqual([['설비 (asset_code)', '사유 (reasons)'], ['ESS1/RACK01', 'batt.soc 완결성 82%, "주의"\n다음 줄'], ['1', '']]);
  });
});

describe('준비도 CSV 행', () => {
  const cell: ReadinessCell = {
    assetId: 2,
    assetCode: 'ESS1/RACK02',
    assetClass: 'ess.rack',
    detectorId: 'ess.capacity_fade',
    failureMode: 'ess.capacity_fade',
    severity: 3,
    status: 'partial',
    missingMetrics: [],
    reasons: [
      { code: 'low_completeness', metricKey: 'batt.current', completeness: 0.8234, required: 0.9 },
      { code: 'coarse_period', metricKey: 'batt.soc', periodS: 300, requiredS: 60 },
      { code: 'short_history', historyDays: 20, requiredDays: 30 },
    ],
  };

  it('헤더는 한국어 (영문 키) 병기, 사유는 한국어 문장을 ; 로 잇는다', () => {
    const rows = readinessCsvRows([cell, { ...cell, status: 'missing', missingMetrics: ['cell.voltage.max', 'cell.voltage.min'], reasons: [] }]);
    expect(rows[0]).toEqual(['설비 경로 (asset_code)', '설비 종류 (asset_class)', '탐지기 (detector_id)', '고장모드 (failure_mode)', '심각도 (severity)', '상태 (status)', '상태 설명 (status_label)', '누락 메트릭 (missing_metrics)', '부족 사유 (reasons)']);
    expect(rows[1]).toEqual(['ESS1/RACK02', 'ess.rack', 'ess.capacity_fade', 'ess.capacity_fade', 3, 'partial', '부분 준비', '', 'batt.current 완결성 82.3% (기준 90% 이상); batt.soc 주기 300초 (기준 60초 이하); 이력 20일 (기준 30일 이상)']);
    expect(rows[2]?.slice(5, 8)).toEqual(['missing', '필수 메트릭 없음', 'cell.voltage.max; cell.voltage.min']);
    expect(reasonText({ code: 'low_completeness', metricKey: 'x', completeness: null, required: 0.9 })).toBe('x 완결성 데이터 없음 (기준 90% 이상)');
  });

  it('메트릭 확보 순위 CSV는 1부터 순위를 매긴다', () => {
    expect(acquisitionCsvRows([{ metricKey: 'heatsink.temp', unlocks: 2, severityWeight: 4, blockedCells: 2 }])).toEqual([
      ['순위 (rank)', '메트릭 (metric_key)', '확보 시 풀리는 셀 (unlocks)', '심각도 가중 (severity_weight)', '관련 누락 셀 (blocked_cells)'],
      [1, 'heatsink.temp', 2, 4, 2],
    ]);
  });
});

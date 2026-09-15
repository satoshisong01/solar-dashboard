// P3 같은 조건 상승 탐지기 4종 표시 이름·bin 라벨. 순수 모듈 (zod·DB 없음).
// bin 키 형식은 탐지기 samplesOf를 따른다: el.sec_rise 'P<kW 하한>|<스택온도 하한>' 또는 'j<전류밀도 하한>|…',
// comp.sec_rise '<압력비 하한>|<외기 하한>', fc.blower_wear '<유량 하한>|<외기 하한>', ess.resistance_growth '<SOC 하한>|<셀온도 하한>'. 온도 없음은 'na'.
import type { RiseDetectorId } from './p3-evidence-types';

export const RISE_DETECTOR_IDS: readonly RiseDetectorId[] = ['el.sec_rise', 'comp.sec_rise', 'fc.blower_wear', 'ess.resistance_growth'];

export const isRiseDetector = (id: string): id is RiseDetectorId => (RISE_DETECTOR_IDS as readonly string[]).includes(id);

export interface RiseMeta {
  readonly subject: string;
  readonly levelUnit: string;
  readonly levelDigits: number;
  readonly conditionHeader: string;
  readonly countWord: string;
  /** 첫 조건 이름 (조건 문장용) */
  readonly loadName: string;
  readonly tempName: string;
}

export const RISE_META: Readonly<Record<RiseDetectorId, RiseMeta>> = {
  'el.sec_rise': { subject: '계통측 시스템 비에너지', levelUnit: 'kWh/kg', levelDigits: 2, conditionHeader: '조건 (운전 부하 · 스택 온도)', countWord: '구간', loadName: '운전 부하', tempName: '스택 온도' },
  'comp.sec_rise': { subject: '압축기 비에너지', levelUnit: 'kWh/kg', levelDigits: 3, conditionHeader: '조건 (압력비 · 외기 온도)', countWord: '회', loadName: '압력비', tempName: '외기 온도' },
  'fc.blower_wear': { subject: '블로워 비전력', levelUnit: 'W/(kg/h)', levelDigits: 2, conditionHeader: '조건 (공기 유량 · 외기 온도)', countWord: '구간', loadName: '공기 유량', tempName: '외기 온도' },
  'ess.resistance_growth': { subject: '랙 직류 내부저항', levelUnit: 'mΩ', levelDigits: 1, conditionHeader: '조건 (SOC · 셀 온도)', countWord: '회', loadName: 'SOC', tempName: '셀 온도' },
};

/** 첫 조건 bin 폭과 단위 (bin 키 접두어 P/j는 el.sec_rise만) */
export interface RiseBinWidths {
  readonly load: number;
  readonly loadUnit: string;
  readonly temp: number;
}

const fixed = (value: number, digits: number): string => (Math.round(value * 10 ** digits) / 10 ** digits).toFixed(digits);
const decimalsOf = (width: number): number => Math.min(3, Math.max(0, (String(width).split('.')[1] ?? '').length));

function rangeText(lowText: string, width: number, unit: string): string | null {
  const low = Number(lowText);
  if (lowText === '' || lowText === 'na' || !Number.isFinite(low)) return null;
  const digits = decimalsOf(width);
  const range = `${fixed(low, digits)}~${fixed(low + width, digits)}`;
  return unit === '' ? range : unit === '%' ? `${range}%` : `${range} ${unit}`;
}

/** bin 키 → '450~500 kW · 55~60 °C'. 값이 없는 조건은 'OO 없음' */
export function riseBinLabel(detectorId: RiseDetectorId, key: string, widths: RiseBinWidths): string {
  const [loadRaw = '', tempRaw = ''] = key.split('|');
  const meta = RISE_META[detectorId];
  const loadText = detectorId === 'el.sec_rise' ? loadRaw.replace(/^[Pj]/, '') : loadRaw;
  const load = rangeText(loadText, widths.load, widths.loadUnit) ?? `${meta.loadName} 없음`;
  const temp = rangeText(tempRaw, widths.temp, '°C') ?? `${meta.tempName} 없음`;
  return `${load} · ${temp}`;
}

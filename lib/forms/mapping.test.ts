import { describe, expect, it } from 'vitest';
import { formValues } from './action-state';
import { parseMappingForm } from './mapping';

const VALID = {
  gatewayId: '2',
  sourceKey: 'COMP1/VIB_RMS',
  assetId: '57',
  metricKey: 'vibration.rms',
  qualifier: '',
  scale: '',
  valueOffset: '',
  periodS: '',
} as const;

const parse = (patch: Readonly<Record<string, string>> = {}) => parseMappingForm({ ...VALID, ...patch });
const errorsOf = (patch: Readonly<Record<string, string>>) => {
  const result = parse(patch);
  if (result.ok) throw new Error('검증이 통과하면 안 됩니다');
  return result.fieldErrors;
};

describe('parseMappingForm', () => {
  it('빈 배율·오프셋·주기는 1·0·null로 채운다', () => {
    expect(parse()).toEqual({
      ok: true,
      input: { gatewayId: 2, sourceKey: 'COMP1/VIB_RMS', assetId: 57, metricKey: 'vibration.rms', qualifier: '', scale: 1, valueOffset: 0, periodS: null },
    });
  });

  it('단위 변환 값과 구분자·주기를 숫자로 바꾼다 (앞뒤 공백 허용)', () => {
    const result = parse({ qualifier: ' loop ', scale: ' 0.001 ', valueOffset: '-273.15', periodS: '60' });
    expect(result).toMatchObject({ ok: true, input: { qualifier: 'loop', scale: 0.001, valueOffset: -273.15, periodS: 60 } });
  });

  it('원본 태그는 공백을 포함해 그대로 둔다', () => {
    expect(parse({ sourceKey: 'ESS1/RACK 01/SOC' })).toMatchObject({ ok: true, input: { sourceKey: 'ESS1/RACK 01/SOC' } });
  });

  it('설비·메트릭을 고르지 않으면 필드별 오류', () => {
    expect(errorsOf({ assetId: '', metricKey: '' })).toEqual({ assetId: '설비를 고르세요', metricKey: '메트릭을 고르세요' });
  });

  it.each([
    ['assetId', '0'],
    ['assetId', '-3'],
    ['assetId', '2147483648'],
    ['gatewayId', '1.5'],
    ['metricKey', 'Vibration.RMS'],
    ['metricKey', 'vibration'],
    ['metricKey', 'vibration..rms'],
  ])('%s=%s는 거부한다', (field, value) => {
    expect(Object.keys(errorsOf({ [field]: value }))).toEqual([field]);
  });

  it('구분자 규칙: 소문자로 시작, 소문자·숫자·_·-, 32자 이하', () => {
    expect(parse({ qualifier: 'inlet_2' }).ok).toBe(true);
    expect(errorsOf({ qualifier: 'Inlet' })).toHaveProperty('qualifier');
    expect(errorsOf({ qualifier: '2nd' })).toHaveProperty('qualifier');
    expect(errorsOf({ qualifier: `a${'b'.repeat(32)}` })).toHaveProperty('qualifier');
  });

  it('배율 0, 숫자가 아닌 배율·오프셋, 범위 밖 주기는 거부한다', () => {
    expect(errorsOf({ scale: '0' })).toEqual({ scale: '배율은 0일 수 없습니다' });
    expect(errorsOf({ scale: '1e-3' })).toEqual({ scale: '배율은(는) 숫자여야 합니다' });
    expect(errorsOf({ valueOffset: '1,000' })).toEqual({ valueOffset: '오프셋은(는) 숫자여야 합니다' });
    expect(errorsOf({ periodS: '0' })).toEqual({ periodS: '수집 주기은(는) 1~86400 사이여야 합니다' });
    expect(errorsOf({ periodS: '2.5' })).toEqual({ periodS: '수집 주기은(는) 정수여야 합니다' });
  });

  it('원본 태그가 없거나 너무 길면 거부한다', () => {
    expect(errorsOf({ sourceKey: '' })).toEqual({ sourceKey: '원본 태그가 없습니다' });
    expect(errorsOf({ sourceKey: 'x'.repeat(201) })).toHaveProperty('sourceKey');
  });

  it('FormData에서 빠진 필드는 빈 값으로 보고, Next의 $ACTION 필드는 무시한다', () => {
    const data = new FormData();
    data.set('$ACTION_ID_abc', '');
    data.set('gatewayId', '2');
    data.set('sourceKey', 'COMP1/VIB_RMS');
    data.set('assetId', '57');
    data.set('metricKey', 'vibration.rms');
    expect(formValues(data)).toEqual({ gatewayId: '2', sourceKey: 'COMP1/VIB_RMS', assetId: '57', metricKey: 'vibration.rms' });
    expect(parseMappingForm(formValues(data))).toMatchObject({ ok: true, input: { scale: 1, valueOffset: 0, periodS: null, qualifier: '' } });
  });
});

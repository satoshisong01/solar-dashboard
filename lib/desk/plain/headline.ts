// 1) 무엇이 어떻게 됐는지 — 탐지기 17종별 한 줄. 근거 스냅샷 없이 발견사항 행(설비 이름 + effect)만으로 만든다.
// 수치는 분석 엔진이 낸 effect 값 그대로이고, 전문 용어 대신 현장에서 쓰는 말로 바꾼다.
import type { EffectView } from '../effect';
import { grewOrShrank, LEAK_DIGITS, size, subjectText, withParticle } from './common';
import type { PlainHeadlineInput } from './types';

type Headline = (subject: string, effect: EffectView) => string | null;

/** 값이 없으면 문장을 만들지 않는다 (제목으로 되돌아간다) */
const has = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** µV/h는 1,000시간 운전당 mV와 숫자가 같다 (21.4 µV/h × 1,000 h = 21.4 mV) */
const perThousandHours = (effect: EffectView): string => size(effect.value);

const HEADLINES: Readonly<Record<string, Headline>> = {
  'ess.capacity_fade': (subject, e) => (has(e.value) ? `${subject}에 담기는 전기의 양이 처음 재던 때보다 ${size(e.value)}% ${grewOrShrank(e.value)}` : null),

  'ess.cell_imbalance': (subject, e) =>
    has(e.baseline) && has(e.current) ? `${subject} 안 셀들의 전압 차이가 ${size(e.baseline)} mV에서 ${size(e.current)} mV로 벌어졌습니다` : null,

  'ess.resistance_growth': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 전기를 주고받을 때 걸리는 저항이 처음보다 ${size(e.value)}% ${grewOrShrank(e.value, '커졌습니다', '작아졌습니다')}` : null),

  'pv.inverter_peer': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 옆의 같은 인버터들보다 ${size(e.value)}% ${e.value > 0 ? '많이' : '적게'} 발전합니다` : null),

  'inv.thermal_derating': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 뜨거워지면 스스로 출력을 줄여서, 발전량의 ${size(e.value, 2)}%를 잃고 있습니다` : null),

  'pv.soiling_rate': (subject, e) => (has(e.value) ? `${subject}의 태양광 판이 더러워지면서 발전량의 ${size(e.value)}%를 잃고 있습니다` : null),

  'el.voltage_rise': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 같은 양의 수소를 만드는 데 필요한 전압이 1,000시간 운전할 때마다 ${perThousandHours(e)} mV씩 오르고 있습니다` : null),

  'fc.voltage_decay': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 전기를 낼 때 셀 전압이 1,000시간 운전할 때마다 ${perThousandHours(e)} mV씩 떨어지고 있습니다` : null),

  'el.sec_rise': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 수소 1 kg을 만드는 데 쓰는 전기가 처음보다 ${size(e.value)}% ${grewOrShrank(e.value)}` : null),

  'comp.sec_rise': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 수소 1 kg을 압축하는 데 쓰는 전기가 처음보다 ${size(e.value)}% ${grewOrShrank(e.value)}` : null),

  'fc.blower_wear': (subject, e) => (has(e.value) ? `${withParticle(subject, '이', '가')} 같은 양의 공기를 보내는 데 쓰는 전기가 처음보다 ${size(e.value)}% ${grewOrShrank(e.value)}` : null),

  'tank.static_leak': (subject, e) => (has(e.value) ? `${subject}에서 수소를 넣지도 빼지도 않는 동안 수소가 하루 ${size(e.value, LEAK_DIGITS)} kg씩 ${grewOrShrank(e.value, '줄고 있습니다', '늘고 있습니다')}` : null),

  'h2chain.mass_balance_gap': (subject, e) =>
    has(e.value) ? `${subject}에서 만든 수소와 쓴 수소를 맞춰 보면 하루 ${size(e.value)}%가 ${e.value > 0 ? '모자랍니다' : '더 나옵니다'}` : null,

  'prv.seat_leak': (subject, e) =>
    has(e.value) ? `연료전지를 세워 둔 동안 ${subject} 뒤쪽 수소 압력이 한 시간에 ${size(e.value)} mbar씩 올라갑니다` : null,

  'hx.fouling': (subject, e) =>
    has(e.baseline) && has(e.current)
      ? `${subject}에서 뜨거운 물과 데워진 물의 온도 차이가 ${size(e.baseline)}도에서 ${size(e.current)}도로 벌어졌습니다 — 열이 예전만큼 넘어가지 않습니다`
      : null,

  // 이 탐지기는 오르지 않아도 압축금지선까지 여유가 좁으면 나온다 — 그때 '올랐습니다'로 쓰면 없던 상승을 말하게 된다
  'o2.purity_drift': (subject, e) => {
    if (!has(e.current)) return null;
    const level = `${subject}에서 나오는 산소에 섞인 수소가 ${size(e.current, 2)}%`;
    return has(e.baseline) && e.current <= e.baseline ? `${level}입니다` : `${level}까지 올랐습니다`;
  },

  'dq.gap_flatline': (subject, e) => {
    if (e.metric === 'dq.flatline_hours') return has(e.value) ? `${subject}의 계측값이 최대 ${size(e.value)}시간 동안 같은 값에 멈춰 있었습니다` : null;
    return has(e.current) ? `${subject}의 계측 데이터가 들어와야 할 양의 ${size(e.current)}%만 들어왔습니다` : null;
  },
};

/** 인박스 한 줄 요약. 탐지기 문장을 만들 수 없으면 주어 + 원래 제목 */
export function plainHeadline(input: PlainHeadlineInput): string {
  const subject = subjectText(input);
  const sentence = HEADLINES[input.detectorId]?.(subject, input.effect);
  return sentence === null || sentence === undefined ? `${subject}: ${input.title}` : `${sentence}.`;
}

/** 탐지기별 문장이 있는지 (테스트가 17종을 모두 덮는지 확인할 때 쓴다) */
export const PLAIN_HEADLINE_DETECTORS: readonly string[] = Object.keys(HEADLINES);

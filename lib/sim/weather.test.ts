import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_MINUTE } from './math';
import { clearSkyIrradiance, createWeather, seasonalMeanTempC, solarPosition } from './weather';

const SAEMANGEUM = { code: 'SIM-B', lat: 35.85, lon: 126.55 };
const kst = (iso: string) => Date.parse(`${iso}+09:00`);

describe('solarPosition', () => {
  it('하지 정오(KST 12:30) 천정각은 약 12°, 자정에는 해가 지평선 아래다', () => {
    const noon = solarPosition(SAEMANGEUM.lat, SAEMANGEUM.lon, kst('2026-06-21T12:30:00'));
    const midnight = solarPosition(SAEMANGEUM.lat, SAEMANGEUM.lon, kst('2026-06-21T00:00:00'));

    expect(Math.acos(noon.cosZenith) * (180 / Math.PI)).toBeGreaterThan(11);
    expect(Math.acos(noon.cosZenith) * (180 / Math.PI)).toBeLessThan(14);
    expect(midnight.cosZenith).toBeLessThan(0);
  });
});

describe('clearSkyIrradiance', () => {
  it('여름 청천 정오 GHI는 950~1100 W/m², 30° 경사면 POA는 850 W/m² 이상', () => {
    const clear = clearSkyIrradiance(SAEMANGEUM.lat, SAEMANGEUM.lon, kst('2026-06-21T12:30:00'), 30);

    expect(clear.ghi).toBeGreaterThan(950);
    expect(clear.ghi).toBeLessThan(1100);
    expect(clear.poa).toBeGreaterThan(850);
  });

  it('겨울 정오는 GHI가 여름보다 낮지만 경사면 덕분에 POA 감소폭은 더 작다', () => {
    const winter = clearSkyIrradiance(SAEMANGEUM.lat, SAEMANGEUM.lon, kst('2026-12-21T12:30:00'), 30);
    const summer = clearSkyIrradiance(SAEMANGEUM.lat, SAEMANGEUM.lon, kst('2026-06-21T12:30:00'), 30);

    expect(winter.ghi).toBeLessThan(summer.ghi * 0.7);
    expect(winter.poa / summer.poa).toBeGreaterThan(winter.ghi / summer.ghi);
  });
});

describe('createWeather', () => {
  it('밤에는 일사량이 0이다', () => {
    const weather = createWeather(SAEMANGEUM, 1);
    const night = weather.sample(kst('2026-07-15T01:00:00'));

    expect(night.ghi).toBe(0);
    expect(night.poa).toBe(0);
  });

  it('같은 시드·같은 날은 조회 순서와 무관하게 같은 날씨를 만든다', () => {
    const t = kst('2026-03-10T11:17:00');
    const direct = createWeather(SAEMANGEUM, 9).sample(t);
    const detoured = createWeather(SAEMANGEUM, 9);
    detoured.sample(t + 40 * MS_PER_DAY);

    expect(detoured.sample(t)).toEqual(direct);
    expect(createWeather(SAEMANGEUM, 10).sample(t)).not.toEqual(direct);
  });

  it('장마철(7월)이 10월보다 평균 운량이 크고 강우 시간이 길다', () => {
    const stats = (month: string) => {
      const weather = createWeather(SAEMANGEUM, 3);
      let cloud = 0;
      let rainMinutes = 0;
      let n = 0;
      for (const year of [2025, 2026, 2027, 2028]) {
        const start = kst(`${year}-${month}-01T00:00:00`);
        for (let t = start; t < start + 28 * MS_PER_DAY; t += 30 * MS_PER_MINUTE) {
          const sample = weather.sample(t);
          cloud += sample.cloud;
          rainMinutes += sample.raining ? 30 : 0;
          n += 1;
        }
      }
      return { cloud: cloud / n, rainMinutes };
    };
    const july = stats('07');
    const october = stats('10');

    expect(july.cloud).toBeGreaterThan(october.cloud + 0.1);
    expect(july.rainMinutes).toBeGreaterThan(october.rainMinutes);
  });

  it('기온은 계절(8월 > 1월)과 일변화(오후 > 새벽)를 따른다', () => {
    const weather = createWeather(SAEMANGEUM, 4);
    const dailyMean = (iso: string) => {
      const start = kst(`${iso}T00:00:00`);
      let sum = 0;
      for (let i = 0; i < 24; i += 1) sum += weather.sample(start + i * 60 * MS_PER_MINUTE).ambientC;
      return sum / 24;
    };

    expect(dailyMean('2026-08-05') - dailyMean('2026-01-15')).toBeGreaterThan(15);
    expect(weather.sample(kst('2026-05-20T15:00:00')).ambientC).toBeGreaterThan(weather.sample(kst('2026-05-20T05:00:00')).ambientC);
  });
});

describe('seasonalMeanTempC', () => {
  it('제주는 겨울에 새만금보다 따뜻하고, 여름 차이는 작다', () => {
    const jan = seasonalMeanTempC(33.36, 15) - seasonalMeanTempC(35.85, 15);
    const aug = seasonalMeanTempC(33.36, 220) - seasonalMeanTempC(35.85, 220);

    expect(jan).toBeGreaterThan(4);
    expect(Math.abs(aug)).toBeLessThan(1.5);
  });
});

describe('createWeather — 편차 구간(대조군)', () => {
  const start = kst('2026-04-10T00:00:00');
  const cold = { startMs: start, endMs: start + 7 * MS_PER_DAY, ambientDeltaC: -10, cloudMin: 0, rampMs: 12 * 3_600_000 };
  const cloudy = { startMs: start, endMs: start + 7 * MS_PER_DAY, ambientDeltaC: 0, cloudMin: 0.85, rampMs: 0 };

  it('기온 편차는 양끝 램프를 거쳐 구간 안에서 그대로 더해지고, 구간 밖은 같다', () => {
    const base = createWeather(SAEMANGEUM, 3);
    const shifted = createWeather(SAEMANGEUM, 3, 30, [cold]);
    const diff = (t: number) => shifted.sample(t).ambientC - base.sample(t).ambientC;

    expect(diff(start - MS_PER_MINUTE)).toBe(0);
    expect(diff(start + 6 * 3_600_000)).toBeCloseTo(-5, 9);
    expect(diff(start + 3 * MS_PER_DAY)).toBeCloseTo(-10, 9);
    expect(diff(start + 7 * MS_PER_DAY)).toBe(0);
    expect(shifted.sample(start + 3 * MS_PER_DAY).poa).toBe(base.sample(start + 3 * MS_PER_DAY).poa);
  });

  it('운량 하한은 구간 동안 일사량을 줄인다', () => {
    const base = createWeather(SAEMANGEUM, 3);
    const dim = createWeather(SAEMANGEUM, 3, 30, [cloudy]);
    const poaSum = (weather: ReturnType<typeof createWeather>) =>
      Array.from({ length: 7 * 1_440 }, (_, i) => weather.sample(start + i * MS_PER_MINUTE).poa).reduce((a, b) => a + b, 0);

    expect(dim.sample(start + 3 * MS_PER_DAY).cloud).toBeGreaterThanOrEqual(0.85);
    expect(poaSum(dim) / poaSum(base)).toBeLessThan(0.75);
  });
});

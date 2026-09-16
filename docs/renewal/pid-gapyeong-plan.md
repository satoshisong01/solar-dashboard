# 가평 2MW 청정수소발전 P&ID 반영 — 구현 제안서

대상 도면: **가평 2MW 청정수소발전 시스템 P&ID (FCND-GP-PID-002 REV.2, 2026-07-17)**
작성 기준일: 2026-09-16 · 근거 조사: [`research/pid/`](./research/pid/) (출처 119건) · 공백 정리: [`research/pid/README.md`](./research/pid/README.md)

이 문서는 **다음 작업이 그대로 집어 쓸 수 있는 형태**로 쓴다. 표의 컬럼은 실제 스키마(`om.asset_class`, `om.metric_def`, `om.point`) 컬럼과 1:1로 맞췄고, 시드 구성안은 `db/seed/templates-*.ts`의 `AssetSpec` 모양을 그대로 따른다.

**이 문서 자체는 설계안이다. 코드·DB 변경은 검토 후 별도 작업으로 한다.**

## 0. 전제와 범위

| # | 전제 | 근거 |
|---|---|---|
| 1 | 스키마 변경은 **없다**. 자산 클래스·메트릭 추가는 `INSERT`만으로 된다 (`db/migrations/20260914090757607_om-catalog.sql` 주석: "메트릭·설비 종류 추가는 스키마 변경 없이 INSERT로 한다") | 기존 설계 |
| 2 | 장부 데이터(반입·출하 전표)는 **새 테이블 1개**가 필요하다. 텔레메트리가 아니므로 `metric_def`에 넣지 않는다 | §4.3 |
| 3 | 메트릭 키는 기존 명명 규칙 `^[a-z][a-z0-9]*(\.[a-z0-9]+)*$`를 지킨다 (밑줄·대문자 불가) | DDL CHECK |
| 4 | 같은 물리량을 위치만 달리 재는 경우 **새 키를 만들지 않고 `qualifier`로 나눈다** (기존 `separator.level` @h2/@o2 패턴) | 기존 설계 |
| 5 | 도면 압력이 게이지압인지 절대압인지 미확정이므로, 시드 명판은 **도면 표기 그대로** 넣고 `pressure_basis` 필드로 근거를 남긴다 | pressure·oxygen 조사 미해결 1번 |
| 6 | 새 탐지기는 전부 기존 게이트 원칙을 따른다 — **입력이 없으면 '판정 불능'**, 0으로 채우지 않기, 기준선 리셋 존중, **안전 판단은 현장 설비·PLC 인터록의 몫** | `lib/analytics/detectors/` 공통 |

---

## 1. 추가할 자산 클래스 (10종)

`om.asset_class` 컬럼: `key`, `level`, `parent_key`, `name_ko`, `nameplate_schema`, `safety_event_codes`.

| key | level | parent_key | name_ko | 명판 필드 (`*` = required) | safety_event_codes | 근거 |
|---|---|---|---|---|---|---|
| `o2.plant` | system | (없음) | 부산물 산소 계통 | `o2_rated_nm3_h`*, `purity_grade`(공업/의료), `sale_contract`(bool) | `O2_ENRICHED_ATMOSPHERE`, `O2_PURITY_LOW`, `ESD` | oxygen |
| `o2.storage.tank` | asset | `o2.plant` | 산소 저장탱크 | `water_volume_m3`*, `max_bar`*, `design_temp_c`, `pressure_basis`(gauge/abs)*, `storage_capacity_m3`(Q=(10P+1)V₁) | `OVERPRESSURE`, `PSV_RELEASE`, `TANK_OVERTEMP` | oxygen |
| `o2.loading` | asset | `o2.plant` | 산소 출하 설비 | `loading_bar`*, `meter_type`*, `meter_accuracy_pct`, `compressor_present`(bool)* | `O2_ENRICHED_ATMOSPHERE`, `LOADING_INTERLOCK_TRIP` | oxygen |
| `hx.recovery` | asset | `fc.plant` | 폐열회수 열교환기 | `duty_kw`*, `type`(plate/shell)*, `wall_type`(single/double)*, `plate_material`, `design_approach_k`, `design_ua_kw_k` | `HX_CROSS_LEAK` | heat |
| `h2.elz.water.pre` | component | `h2.elz.water` | 전처리 설비 (활성탄·연수) | `softener_capacity_m3`*, `resin_volume_l`, `regen_mode`(auto/manual) | (없음) | water |
| `h2.elz.water.ro` | component | `h2.elz.water` | RO 막 유닛 | `permeate_m3_h`*, `design_recovery_pct`*, `membrane_model`, `element_count` | (없음) | water |
| `h2.elz.water.tank` | component | `h2.elz.water` | DI 물탱크 | `volume_m3`*, `vent_filter`(bool), `material` | `TANK_LEVEL_LOW`, `TANK_OVERFLOW` | water |
| `h2.prv` | asset | (없음) | 수소 감압밸브 스키드 | `inlet_bar_max`*, `outlet_bar_set`*, `stages`(1/2)*, `class_ac`, `class_sg`, `min_dp_bar`, `downstream_volume_m3`, `seat_material` | `OVERPRESSURE`, `PSV_RELEASE` | pressure |
| `h2.delivery` | asset | (없음) | 외부 수소 반입(하역) 설비 | `meter_type`*, `meter_accuracy_pct`*, `design_bar`*, `bank_present`(bool)*, `vent_stack`(bool) | `H2_LEAK_L1`, `H2_LEAK_L2`, `GROUNDING_FAULT`, `ESD` | supply |
| `h2.trailer` | component | `h2.delivery` | 튜브트레일러 (체류) | `vessel_type`*(I/IV), `water_volume_l`*, `cylinder_count`*, `max_bar`*, `heel_bar`*, `supplier` | `LOW_TEMP_TRIP` | supply |

### 1.1 기존 클래스에 추가할 명판 필드

| 클래스 | 추가 필드 | 왜 |
|---|---|---|
| `h2.storage.bank` | `pressure_basis`(gauge/abs)*, `min_outlet_bar`(감압밸브 최소 입구 차압으로 정해지는 인출 하한) | 재고 3.3% 차이·가용량 계산 (pressure) |
| `h2.elz.water` | `feed_m3_h`*, `recycle_m3_h`, `recycle_source`(gas_condensate/fc_exhaust/loop) | 원단위·재순환율 KPI의 분모 (water) |
| `fc.cooling` | `dump_cooler_kw` | FC 잔여 발열 1,664 kWth 처리 설비 확인 (heat) |
| `h2.elz` | `nm3_reference_c`(0/15/20)* | Nm³ 기준조건 — 모든 질량 환산이 7% 달라진다 (supply) |

> **`fc.humidifier`는 만들지 않는다.** 도면에 가습기가 있지만 별도 계기가 없어 포인트가 0개인 자산이 된다. 포인트가 붙는 시점에 만든다 — 지금 만들면 준비도 매트릭스에 '데이터없음' 행만 늘린다.

---

## 2. 추가할 메트릭 (신규 54종 + 기존 12종 재사용)

`om.metric_def` 컬럼 그대로: `key`, `quantity`, `unit`, `value_kind`, `rollup`, `hard_min`, `hard_max`, `expected_min`, `expected_max`, `flatline_max_s`, `name_ko`.
`주기`는 `om.point.period_s` 권장값이다. 하드 범위는 **물리적으로 불가능한 값**(HARD_RANGE 비트), 기대 범위는 **정상 운전의 전형 범위**라는 기존 정의를 지켰다.

### 2.1 부산물 산소 (신규 9종)

| key | name_ko | quantity | unit | value_kind | rollup | hard | expected | flatline_s | 주기 | 근거 |
|---|---|---|---|---|---|---|---|---|---|---|
| `o2.flow.mass` | 산소 질량유량 | mass_flow | kg/h | gauge | avg | −1 / 5000 | 0 / 400 | — | 10 | 정격 357 kg/h. qualifier `production`·`loading`·`vent` |
| `o2.mass.total` | 누적 산소 생산량 | mass | kg | counter | delta | 0 / 1e9 | — | — | 60 | `h2.mass.total` 대칭 |
| `o2.shipped.mass.total` | 누적 산소 출하량 | mass | kg | counter | delta | 0 / 1e9 | — | — | 60 | 매출·계량편차 기준 |
| `o2.vent.mass.total` | 누적 산소 방출량 | mass | kg | counter | delta | 0 / 1e9 | — | — | 60 | 직접 계측 없으면 원장 잔차 추정 + `estimated` 플래그 |
| `o2.inventory` | 산소 저장 재고(Z 보정) | mass | kg | gauge | last | 0 / 1e6 | 0 / 700 | — | 60 | 만재 637 kg. PLC 미제공 시 탐지기가 EOS로 계산 |
| `o2.purity` | 제품 산소 순도 | purity | % | gauge | avg | 0 / 100 | 99.0 / 100 | 21600 | 300 | 법정 1일 1회 99.5% 이상 확인 |
| `o2.dewpoint` | 제품 산소 이슬점 | dewpoint | °C | gauge | avg | −110 / 60 | −60 / −20 | 21600 | 300 | 건조기 파과 조기 탐지 |
| `o2.detector.pct` | 대기 산소 농도 | concentration | % | gauge | max | 0 / 100 | 19.5 / 23.5 | — | 5 | 23.5% 초과 산소농축, 18% 미만 질식. qualifier `vent`·`tankroom`·`loading` |
| `o2.loading.pressure` | 출하 헤더 압력 | pressure | bar | gauge | avg | −1 / 300 | 0 / 200 | — | 10 | 충전 완료 판정·잔압 계상 |

### 2.2 폐열회수 (신규 11종)

| key | name_ko | quantity | unit | value_kind | rollup | hard | expected | flatline_s | 주기 | 근거 |
|---|---|---|---|---|---|---|---|---|---|---|
| `hx.temp.hot.in` | 열교환기 1차측 입구 온도 | temperature | °C | gauge | avg | −40 / 200 | 30 / 95 | 21600 | 10 | 설계 75 °C (TT-301) |
| `hx.temp.hot.out` | 열교환기 1차측 출구 온도 | temperature | °C | gauge | avg | −40 / 200 | 20 / 90 | 21600 | 10 | 설계 60 °C (TT-302) |
| `hx.temp.cold.in` | 열교환기 2차측 입구 온도 | temperature | °C | gauge | avg | −40 / 150 | 0 / 45 | 21600 | 10 | **TT-304 신설 필수** — 절감량 계산 전체가 여기 걸린다 |
| `hx.temp.cold.out` | 열교환기 2차측 출구 온도 | temperature | °C | gauge | avg | −40 / 150 | 5 / 80 | 21600 | 10 | 설계 55 °C (TT-303) = 수전해 급수 |
| `hx.flow.hot` | 열교환기 1차측 유량 | volume_flow | m³/h | gauge | avg | −1 / 1000 | 0 / 40 | — | 10 | 350 kW·ΔT 15 K 기준 약 20 m³/h. 없으면 Q_hot 불가 |
| `hx.flow.cold` | 열교환기 2차측 유량 | volume_flow | m³/h | gauge | avg | −1 / 1000 | 0 / 3 | — | 10 | 설계 0.5 m³/h (FT-101과 동일 지점일 수 있음 — 확인) |
| `hx.pressure.diff.hot` | 열교환기 1차측 차압 | pressure | kPa | gauge | avg | −500 / 2000 | 0 / 150 | — | 10 | ΔP ∝ Q^1.75 정규화 |
| `hx.pressure.diff.cold` | 열교환기 2차측 차압 | pressure | kPa | gauge | avg | −500 / 2000 | 0 / 150 | — | 10 | 막히면 수전해 급수 부족으로 직결 |
| `hx.heat.recovered` | 회수 열출력 | power | kW | gauge | avg | −100 / 20000 | 0 / 400 | — | 10 | 도면 350 kWth 대비 실적 |
| `hx.heat.total` | 누적 회수 열량 | energy | kWh | counter | delta | 0 / 1e9 | — | — | 60 | 적산열량계 2등급, ΔΘmin ≤ 3 K |
| `hx.heat.dump` | 방열(덤프) 열출력 | power | kW | gauge | avg | −100 / 20000 | 0 / 2200 | — | 60 | 도면 수치대로면 정상운전에서도 1,664 kWth |

### 2.3 수처리 (신규 19종)

| key | name_ko | quantity | unit | value_kind | rollup | hard | expected | flatline_s | 주기 | 근거 |
|---|---|---|---|---|---|---|---|---|---|---|
| `water.temp` | 수온 | temperature | °C | gauge | avg | −10 / 100 | 1 / 60 | 21600 | 60 | 전도도 온도보상·동결·RO 정규화 (TT-303) |
| `water.flow.feed` | 정제수 급수 유량 | volume_flow | m³/h | gauge | avg | −1 / 100 | 0 / 2 | — | 60 | 설계 0.5 (FT-101) |
| `water.flow.recycle` | 회수수 재순환 유량 | volume_flow | m³/h | gauge | avg | −1 / 100 | 0 / 1 | — | 60 | 설계 0.3. **FT-102 신설 필수** |
| `water.volume.total` | 누적 급수량 | volume | m³ | counter | delta | 0 / 1e7 | — | — | 300 | 원단위 KPI 분자 (순시 적분보다 오차 작다) |
| `water.tank.level` | 물탱크 수위 | level | % | gauge | avg | 0 / 100 | 10 / 95 | 21600 | 60 | 20 m³ 기준 1%p ≈ 0.2 m³ (LT-101) |
| `water.level.alarm` | 물탱크 수위 스위치 | state | (없음) | bool | last | — | — | — | 10 | 아날로그와 독립 채널이어야 고착과 실제 이상을 가른다. qualifier `low`·`high` |
| `water.resistivity` | 순수 비저항 | resistivity | MΩ·cm | gauge | avg | 0 / 20 | 1 / 18.3 | — | 10 | Nel이 비저항으로 사양 규정(Type I >10) |
| `water.ph` | 원수 pH | ph | (없음) | gauge | avg | 0 / 14 | 5 / 9 | — | 3600 | RO 스케일 지수·실리카 용해도 |
| `water.hardness` | 경도 (as CaCO₃) | concentration | mg/L | gauge | avg | 0 / 1000 | 0 / 5 | — | 86400 | 연수 후단 5 초과 시 즉시 경보 |
| `water.silica` | 실리카 (as SiO₂) | concentration | µg/L | gauge | avg | 0 / 1e6 | 0 / 10 | — | 86400 | **실리카 파과가 전도도 파과에 선행** (ASTM Type I·II 한계 3) |
| `water.toc` | 총유기탄소 | concentration | µg/L | gauge | avg | 0 / 1e6 | 0 / 50 | — | 86400 | 전도도가 못 잡는 비전도성 오염 |
| `water.chloride` | 염소이온 | concentration | µg/L | gauge | avg | 0 / 1e7 | 0 / 50 | — | 86400 | Ti계 PTL·BoP 공식 유발 |
| `ro.flow.permeate` | RO 투과유량 | volume_flow | m³/h | gauge | avg | −1 / 100 | 0 / 3 | — | 60 | NPF 산출 원자료 |
| `ro.flow.reject` | RO 농축수 유량 | volume_flow | m³/h | gauge | avg | −1 / 100 | 0 / 2 | — | 60 | 회수율·농축배수 |
| `ro.pressure.feed` | RO 공급 압력 | pressure | bar | gauge | avg | −1 / 100 | 5 / 25 | — | 60 | 같은 투과유량에서 상승 = 오염 |
| `ro.pressure.diff` | RO 공급–농축 차압 | pressure | bar | gauge | avg | −1 / 20 | 0 / 3 | — | 60 | 정규화 +10~15%면 세정 시점 |
| `filter.pressure.diff` | 필터 차압 | pressure | bar | gauge | avg | −1 / 20 | 0 / 1.5 | — | 60 | 전처리·PRV 상류 공용. qualifier `prefilter`·`prv` |
| `polisher.volume.total` | 혼상수지 누적 통수량 | volume | m³ | counter | last | 0 / 1e7 | — | — | 3600 | **교체 시 리셋** — `run.hours`와 같은 counter/last |
| `pump.power` | 펌프 소비전력 | power | kW | gauge | avg | −1 / 5000 | 0 / 200 | — | 60 | 유량/전력 비로 폐색과 임펠러 마모 구분. qualifier `feed`·`loop`·`ro`·`hx` |

### 2.4 감압·버퍼 (신규 4종)

| key | name_ko | quantity | unit | value_kind | rollup | hard | expected | flatline_s | 주기 | 근거 |
|---|---|---|---|---|---|---|---|---|---|---|
| `h2.pressure.setpoint` | 수소 압력 설정값 | pressure | bar | gauge | last | −1 / 1100 | 0 / 40 | — | 300 | 상수라도 현장 재조정 이력이 있어야 편차 KPI가 성립 |
| `h2.pressure.ripple` | 수소 압력 리플(1분 P-P) | pressure | bar | gauge | max | 0 / 100 | 0 / 0.1 | — | 60 | **PLC가 1초 기준으로 산출해야 한다** — 60초 샘플링으로는 헌팅을 원리상 못 본다 |
| `valve.position` | 밸브 개도 | ratio | % | gauge | avg | 0 / 100 | 0 / 100 | — | 60 | 같은 유량에서 개도 증가 = 시트 마모·필터 막힘 |
| `vent.temp` | 방출관 온도 | temperature | °C | gauge | avg | −60 / 200 | −30 / 60 | 21600 | 300 | 수소는 상온 교축에서 온도가 오른다 → PSV 시머링 신호 |

### 2.5 외부 반입 (신규 11종)

| key | name_ko | quantity | unit | value_kind | rollup | hard | expected | flatline_s | 주기 | 근거 |
|---|---|---|---|---|---|---|---|---|---|---|
| `h2.delivery.flow.mass` | 하역 질량유량 | mass_flow | kg/h | gauge | avg | −1 / 5000 | 0 / 600 | — | 1 | 코리올리 ±0.5% (FT-501) |
| `h2.delivery.mass.total` | 누적 반입량 | mass | kg | counter | delta | 0 / 1e9 | — | — | 60 | **원장 `delivered` 항의 1순위 소스** |
| `h2.delivery.pressure` | 하역 헤더 압력 | pressure | bar | gauge | avg | −1 / 1100 | 0 / 500 | — | 5 | 버퍼 압력에 근접하면 하역 구동력 소실 |
| `h2.delivery.temp` | 하역 가스 온도 | temperature | °C | gauge | avg | −60 / 150 | −40 / 60 | — | 5 | Type IV 저온 트립 판단 입력 |
| `h2.delivery.state` | 하역 상태 코드 | state | (없음) | state | last | — | — | — | 5 | 대기/연결/퍼지/하역중/종료/분리 — 구간 분할의 기준 |
| `h2.delivery.ground` | 접지 연속성 양호 | state | (없음) | bool | last | — | — | — | 5 | EIGA TB 51: 매 납품 확인, 25 Ω 이하 |
| `h2.trailer.pressure` | 트레일러 잔압 | pressure | bar | gauge | avg | −1 / 1100 | 0 / 500 | — | 60 | 하역 종료 판정·회수율·heel 정산 |
| `h2.trailer.temp` | 트레일러 온도 | temperature | °C | gauge | avg | −60 / 150 | −40 / 60 | 21600 | 60 | 열평형 후 잔량 환산 |
| `h2.trailer.inventory` | 트레일러 잔량(Z 보정) | mass | kg | gauge | last | 0 / 1e6 | 0 / 600 | — | 60 | `h2.inventory`와 같은 계산, 자산만 다르다 |
| `h2.trailer.count` | 체류 트레일러 수 | count | (없음) | gauge | last | 0 / 50 | 0 / 8 | — | 3600 | 체류 트레일러가 사실상 주 저장설비 |
| `h2.vent.mass.total` | 누적 수소 방출량 | mass | kg | counter | delta | 0 / 1e9 | — | — | 60 | 지금 원장의 `vented_est`는 퍼지 횟수 추정뿐이라 하역 벤트가 통째로 잔차에 섞인다 |

### 2.6 기존 키 재사용 (신규 생성 금지, qualifier만 추가) — 12종

| 기존 키 | 추가 qualifier | 쓰는 곳 |
|---|---|---|
| `tank.pressure` | `o2` | PT-401 산소탱크 압력 |
| `tank.temp` | `o2`, `buffer.gas`, `buffer.skin`, `di.water` | **신설 계기 3점의 착지점** |
| `h2.in.o2` | `o2.product` | AT-401 — 법정 압축금지선(2%) 감시 |
| `h2.pressure` | `buffer`, `fc.inlet` | PT-201 / PT-202 |
| `h2.flow.mass` | `elz.out` | FT-201 |
| `h2.purity` | `delivered` | 반입 성적서 순도 |
| `h2.inventory` | `buffer` | 버퍼 재고 |
| `water.conductivity` | `raw`, `softener`, `ro`, `product`, `loop`, `feed`, `feed.in` | 7지점 — 기존 2지점에서 확장 |
| `water.flow` | `loop` | 애노드 순환 루프 |
| `valve.open` | `o2.vent`, `o2.loading`, `buffer.outlet`, `delivery` | 정지 구간 게이트 |
| `op.state` | `o2`, `delivery` | 구간 분할 |
| `gas.detector.ppm` | `prv.skid`, `loading` | 외부 누설 |

### 2.7 metric_def에 넣지 **않는** 값

| 값 | 왜 안 넣나 | 어디에 두나 |
|---|---|---|
| `hx.ua` (kW/K), `hx.temp.approach` (K) | 네 온도와 유량에서 **계산되는 값**이다. 포인트로 받으면 벤더 계산식을 검증할 수 없다 | 탐지기 산출값 + `kpi_daily` |
| `ro.npf.index`, `o2.recovery.ratio`, `water.swc` | 같은 이유 (정규화·비율) | KPI (§6) |
| `h2.import.invoice.mass`, `h2.import.heel.mass`, `h2.import.unit.price`, `h2.import.grade` | **전표 값**이다. 시계열이 아니라 건별 레코드이고 사람이 입력한다 | `om.h2_delivery` 테이블 (§4.3) |
| `o2.quality.check` (법정 1일 1회 품질검사 기록) | 같은 이유 | `om.asset_event` 또는 준수 체크리스트 |

---

## 3. 가평 사이트 시드 구성안

`db/seed/sites.ts`에 사이트 1곳, `db/seed/templates-hydrogen.ts`·`templates-solar.ts`에 템플릿 함수를 더한다. 코드 규칙은 기존과 같다 — 설비 코드는 사이트 안 경로, 태그 `source_key`는 `${설비코드}/${태그}`.

```
site: GP-01 · 가평 청정수소발전 · lat 37.83 / lon 127.51 · Asia/Seoul
attributes: { simulated: false, layout: 'integrated', control_group: false, pid_rev: 'FCND-GP-PID-002 REV.2' }
```

### 3.1 설비 트리 (사이트 → 시스템 → 설비 → 부품)

| 코드 | 클래스 | 이름 | 명판 (도면 그대로) | 중요도 |
|---|---|---|---|---|
| `PV1` | `pv.plant` | 태양광 발전설비 | `dc_kwp` 1500, `ac_kw` 1500 | 4 |
| `PV1/INV1`~`INV3` | `pv.inverter` | 태양광 인버터 1~3 | `ac_kw` 500, `dc_kwp` 500, `mppt_count` 2 | 4 |
| `ESS1` | `ess.plant` | ESS 설비 (수전해 평활) | `energy_kwh` 2000, `power_kw` 1000, `chemistry` 'LFP' | 4 |
| `ESS1/PCS1` | `ess.pcs` | ESS PCS | `power_kw` 1000 | 4 |
| `ESS1/RACK1`~`RACK4` | `ess.rack` | 배터리 랙 1~4 | `energy_kwh` 500 | 4 |
| `ELZ1` | `h2.elz` | PEM 수전해 설비 | `rated_kw` **2500**, `technology` 'PEM', `h2_rated_kg_h` **44.9**, `outlet_bar` **30**, `nm3_reference_c` unknown | 5 |
| `ELZ1/STACK1` | `h2.elz.stack` | 전해 스택 | `rated_current_a` unknown, `cell_count` unknown — **벤더 확인** | 5 |
| `ELZ1/RECT1` | `h2.elz.rectifier` | 정류기 | `rated_dc_kw` 2500, DC **750 V** | 4 |
| `ELZ1/WTU1` | `h2.elz.water` | 순수 제조설비 | `capacity_l_h` **500**, `feed_m3_h` 0.5, `recycle_m3_h` 0.3, `recycle_source` unknown | 4 |
| `ELZ1/WTU1/PRE1` | `h2.elz.water.pre` | 전처리 (활성탄·연수) | **구성 미확인** — 동해 규격 기준 가정 | 3 |
| `ELZ1/WTU1/RO1` | `h2.elz.water.ro` | RO 막 유닛 | `permeate_m3_h` 0.5~0.7, `design_recovery_pct` 75 (가정) | 3 |
| `ELZ1/WTU1/TANK1` | `h2.elz.water.tank` | DI 물탱크 | `volume_m3` **20** | 3 |
| `ELZ1/GLS1` | `h2.elz.gls` | 기액분리기 | `design_bar` 35 | 4 |
| `ELZ1/DRYER` | `h2.elz.dryer` | 수소 정제·건조기 | `type` unknown, `dewpoint_target_c` −70 (가정) | 3 |
| `H2BUF1` | `h2.storage.bank` | 수소 버퍼탱크 | `tank_count` 1, `water_volume_l` **50000**, `max_bar` **30**, `usable_kg` 103, `pressure_basis` unknown | 5 |
| `H2BUF1/TANK1` | `h2.storage.tank` | 버퍼 용기 | `water_volume_l` 50000, `max_bar` 30 | 5 |
| `PRV1` | `h2.prv` | 수소 감압밸브 스키드 | `inlet_bar_max` **30**, `outlet_bar_set` **0.8**, `stages` unknown, `downstream_volume_m3` unknown | 5 |
| `FC1` | `fc.plant` | PEM 연료전지 발전설비 | `rated_kw` **2000**, `technology` 'PEMFC', DC **650 V** | 5 |
| `FC1/STACK1`~`STACK2` | `fc.stack` | 연료전지 스택 1~2 | `cell_count`·`active_area_cm2`·`rated_current_a` unknown | 5 |
| `FC1/BLOWER1` | `fc.blower` | 공기 블로워 | `rated_kw` unknown | 3 |
| `FC1/COOL1` | `fc.cooling` | 스택 냉각계통 | `rated_flow_l_min` unknown, `dump_cooler_kw` **미확인 — 필수 질의** | 4 |
| `FC1/HX1` | `hx.recovery` | 폐열회수 열교환기 HX-301 | `duty_kw` **350**, `wall_type` unknown, `design_approach_k` 20, `design_ua_kw_k` 0.76 | 4 |
| `PCS1` | `ess.pcs` | 연료전지 PCS | `power_kw` **2500** (DC ⇄ AC 380 V) | 4 |
| `MTR1` | `grid.meter` | 계통 연계 계량기 | `voltage_v` **22900** | 4 |
| `WX1` | `wx.station` | 기상관측 설비 | `poa_tilt_deg` 30 (가정) | 3 |
| `O2P1` | `o2.plant` | 부산물 산소 계통 | `o2_rated_nm3_h` **250**, `purity_grade` unknown, `sale_contract` unknown | 3 |
| `O2P1/TANK1` | `o2.storage.tank` | 산소 저장탱크 | `water_volume_m3` **30**, `max_bar` **15**, `pressure_basis` unknown, `storage_capacity_m3` 480 | 3 |
| `O2P1/LOAD1` | `o2.loading` | 산소 출하 설비 | `compressor_present` **false (도면 기준)**, `loading_bar` unknown | 3 |
| `H2DLV1` | `h2.delivery` | 외부 수소 반입 설비 | `bank_present` unknown, `meter_type` unknown — **도면에 설비 자체가 없다** | 5 |
| `H2DLV1/TRL1`~`TRL2` | `h2.trailer` | 체류 트레일러 | `vessel_type`·`water_volume_l`·`cylinder_count` unknown | 3 |
| `H2DET1`~`H2DET4` | `h2.detector` | 수소 누출 검지기 | `location` ELZ1 / H2BUF1 / PRV1 / H2DLV1 | 5 |

> **`unknown`을 빈칸으로 두지 말고 명판에 `null`로 넣고 `nameplate_source` 주석을 남긴다.** 준비도 매트릭스가 "명판 없음"으로 잡아 주기 때문에, 벤더 회신이 오기 전까지 누락 목록이 자동으로 관리된다.

### 3.2 포인트 목록 (도면 태그 10점 + 신설 요청 40점)

**도면에 이미 있는 태그 (지금 매핑 가능)**

| 설비 | 메트릭 | qualifier | 태그 | 주기 | 도면 태그 |
|---|---|---|---|---|---|
| `H2BUF1` | `h2.pressure` | `buffer` | `P_BUF` | 60 | PT-201 |
| `FC1` | `h2.pressure` | `fc.inlet` | `P_FC_IN` | 60 | PT-202 |
| `O2P1/TANK1` | `tank.pressure` | `o2` | `P_O2` | 10 | PT-401 |
| `ELZ1/WTU1` | `water.flow.feed` | — | `F_FEED` | 60 | FT-101 |
| `ELZ1` | `h2.flow.mass` | `elz.out` | `F_H2` | 60 | FT-201 |
| `FC1` | `fc.h2.consumption` | — | `F_H2_FC` | 60 | FT-301 |
| `FC1/COOL1` | `fc.coolant.temp.out` | — | `T_COOL_OUT` | 10 | TT-301 |
| `FC1/HX1` | `hx.temp.hot.in` | — | `T_HOT_IN` | 10 | TT-301 (공용) |
| `FC1/HX1` | `hx.temp.hot.out` | — | `T_HOT_OUT` | 10 | TT-302 |
| `FC1/HX1` | `hx.temp.cold.out` | — | `T_COLD_OUT` | 10 | TT-303 |
| `ELZ1/WTU1` | `water.temp` | — | `T_WATER` | 60 | TT-303 (공용) |
| `ELZ1/WTU1/TANK1` | `water.tank.level` | — | `LVL` | 60 | LT-101 |

> TT-301과 TT-303이 두 설비에 걸친다. **같은 물리 계기를 두 포인트로 매핑하지 말고**, 한쪽을 정본으로 두고 다른 쪽은 분석 계층이 참조하게 한다 (`om.point`의 `UNIQUE (gateway_id, source_key)` 제약 때문에 같은 태그를 두 번 매핑할 수 없다). TT-303이 HX 예열 전인지 후인지 미확정이므로 **위치 확정 전에는 `hx.temp.cold.out`만 매핑하고 `water.temp`는 비워 둔다**.

**신설 요청 포인트**는 §8과 [`data-contract-draft.md` 부록 B](./data-contract-draft.md)에 주기·정확도와 함께 정리했다.

### 3.3 시뮬레이터·대조군

가평은 **실사이트**이므로 `simulated: false`다. 다만 탐지기 튜닝과 평가 게이트를 위해 같은 구성의 가상 사이트 `SIM-D`(가평 복제, `control_group: true`)를 함께 두면, 기존 SIM-B/SIM-C처럼 **고장 없는 대조군**으로 새 탐지기 6종의 오탐률을 먼저 잴 수 있다. 이건 P3에서 이미 검증된 방식이다.

---

## 4. 물질수지 확장안

### 4.1 수소 원장 식 (`h2chain.mass_balance_gap@2`)

```
현행  (lib/analytics/ledger/hydrogen.ts)
  residual     = produced − fc_consumed − stored_delta − vented_est
  residual_pct = residual / max(produced, fc_consumed, residualFloorKg) × 100

제안  (@2)
  residual     = produced + delivered − fc_consumed − stored_delta − vented_est
  residual_pct = residual / max(produced + delivered, fc_consumed, residualFloorKg) × 100

  delivered    = Σ(하역 적산 Δ)                         ← 1순위: h2.delivery.mass.total
               = Σ(전표 반입량)                          ← 2순위: om.h2_delivery.invoice_mass_kg
               = null                                     ← 둘 다 없으면 '판정 불능' (0으로 채우지 않는다)
  stored_delta = Δ(버퍼 재고) [+ Δ(체류 트레일러 재고)]   ← 재고 경계는 사이트 설정으로 고른다
```

**세 가지 규칙**을 함께 넣어야 이 식이 실제로 동작한다.

1. **`delivered` 결측일은 0이 아니라 판정 불능이다.** 0으로 채우면 반입을 손실로 오인해 매번 발화한다.
2. **재고 경계는 사이트 설정값이고 버전이 붙는다.** `inventory_scope: 'buffer' | 'buffer+trailer'`. 경계가 바뀐 날은 `baselineReset`으로 표시해 탐지기 기준 구간을 끊는다 — 안 그러면 트레일러 1대분 점프가 누설로 보인다.
3. **`site_energy_daily.h2_kg`에 필드를 더한다** (JSONB라 마이그레이션 없이 된다):
   `{ produced, delivered, fc_consumed, stored_delta, vented_est, residual, residual_pct, method{…, delivered: 'meter'|'invoice'|null}, aux{…, trailer_inventory_kg, delivery_events} }`.
   `calc_version`을 `h2_ledger@2`로 올리고, `@1`로 계산된 과거 행은 다시 계산하지 않는다(기존 재계산 정책과 같다).

**Sankey 반영**: 공급측에 `delivered` 노드를 더한다 — 공급 {생산, 반입, 저장 인출, 잔차 유입} = 수요 {연료전지, 저장 증가, 배기, 잔차 손실}. 항등식은 그대로 성립한다.

### 4.2 산소·물 원장 (신규, 수소와 같은 구조)

```
산소  o2_kg = { produced_theoretical, shipped, vented_est, stored_delta, residual, residual_pct }
      produced_theoretical = Σ(h2 생산 Nm³) × 0.5 × 1.429 × η_recovery
      → 이론생산 − 출하 − Δ재고 = 방출 + 누설

물    water_m3 = { feed, recycle, stoichiometric, drain_measured, stored_delta, residual }
      stoichiometric = 8.93 L/kg × Δ(자체 생산 수소 kg)   ← 외부 반입 수소는 반드시 제외
      → feed + recycle − 화학양론 − 드레인 − Δ재고 = 잔차
```

둘 다 `site_energy_daily`에 JSONB 컬럼을 하나씩 더하는 방식(`o2_kg`, `water_m3`)이면 **마이그레이션이 컬럼 추가 2개**로 끝난다. 산소·물 계측이 없는 사이트는 `NULL`이라 기존 사이트에 영향이 없다.

### 4.3 반입·출하 기록 — 사람이 입력하는 방식

**정비이력 CSV(`lib/maintenance/action-csv.ts`)와 똑같은 패턴**을 쓴다. 새 개념을 만들지 않는다.

```sql
-- om.h2_delivery : 수소 반입 한 건 = 한 행
CREATE TABLE om.h2_delivery (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id       smallint NOT NULL REFERENCES om.site (id),
  asset_id      integer REFERENCES om.asset (id),        -- 트레일러 자산 (있으면)
  delivered_at  timestamptz NOT NULL,                     -- 하역 완료 시각 (KST 일 귀속 기준)
  supplier      text NOT NULL,
  trailer_no    text,
  invoice_mass_kg   double precision NOT NULL CHECK (invoice_mass_kg >= 0),
  heel_mass_kg      double precision CHECK (heel_mass_kg >= 0),
  unit_price_krw    double precision CHECK (unit_price_krw >= 0),
  price_basis   text,                                     -- 운송비·할증·부가세 포함 여부
  grade         text,                                     -- 청정수소 1~4 / 미인증
  purity_pct    double precision,                         -- 성적서 값
  basis         text NOT NULL DEFAULT 'mass_kg',          -- 계량 기준 (kg / Nm³@0°C / Nm³@20°C)
  source        text NOT NULL CHECK (source IN ('manual', 'csv')),
  actor         text NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, supplier, trailer_no, delivered_at)     -- CSV 재업로드 시 중복 방지
);
```

산소 출하는 같은 모양의 `om.o2_shipment`(`shipped_at`, `buyer`, `vehicle_no`, `invoice_mass_kg`, `unit_price_krw`, `purity_pct`, `quality_check_id`)로 만든다.

**CSV 형식** — 기존 `ACTION_CSV_HEADER`와 같은 규칙(첫 줄 헤더 고정, 선택 컬럼은 뒤에, 오류가 한 행이라도 있으면 아무것도 저장하지 않음):

```
site_code,delivered_at,supplier,trailer_no,invoice_mass_kg,heel_mass_kg,unit_price_krw,grade,purity_pct,note
GP-01,2026-10-02T14:30+09:00,○○가스,12가3456,318.4,42.1,9800,미인증,99.97,
```

**화면**: `/settings/market`의 시장가격 입력과 같은 자리 구조로 `/settings/supply`를 만든다 — 수기 입력 폼 1개 + CSV 미리보기·적용 1개. 서버 액션은 `previewDeliveryCsvAction` / `applyDeliveryCsvAction`이고, 미리보기 결과를 믿지 않고 **서버에서 같은 규칙으로 다시 검증**한다(기존 `applyMarketCsvAction` 주석의 원칙 그대로).

**대조 규칙**: `h2.delivery.mass.total`(계량)과 `invoice_mass_kg`(전표)가 둘 다 있으면 건별 차이율을 계산하고, 하나만 있으면 그것을 `delivered`로 쓰되 `method.delivered`에 출처를 남긴다. 둘 다 없으면 그날은 판정 불능이다.

---

## 5. 새 탐지기 제안 (6종)

기존 14종과 겹치지 않는 것만 골랐다. 각 항목의 `평가 게이트`는 SIM 대조군에서 **오탐 0**을 확인하고 켠다는 기존 P3 절차를 뜻한다.

### 5.1 `prv.lockup_creep` — 감압밸브 시트 누설 (락업 크리프)

| 항목 | 내용 |
|---|---|
| 대상 | `h2.prv` |
| 입력 | `h2.pressure`@`fc.inlet` (필수), `h2.pressure`@`buffer` (필수), `h2.pressure.setpoint`, `fc.h2.consumption` (필수), `valve.open`@`buffer.outlet`, `op.state`@FC1, `ambient.temp`, `tank.temp`@`buffer.gas` |
| 방법 | 무유동 hold 구간(FT-301 < 검출한계 AND FC 정지 AND 상류 개방, 연속 ≥30분)을 뽑아 PT-202에 Theil–Sen 회귀 → `creep_rate`[mbar/h], `lockup_offset`[%]. **핵심은 공급압 효과와의 판별 자동화** — 구간 후반 50%의 기울기가 전반 50%의 1/3 이하로 떨어지면 '안정(공급압 효과, 정상)', 계속 유지되면 '크리프(시트 누설)'. 동시에 `d(P_out)/d(P_in)` 회귀 잔차만 크리프로 인정한다 |
| 임계 | 경고 `max(3σ_meas, 13 mbar/h)` (하류 0.5 m³ 기준 약 0.1 NL/min) · 주의 `130 mbar/h` (약 1 NL/min) · 락업 오프셋은 명판 SG 등급(미상이면 SG 10 = +10%) · **3회 연속 hold 구간 경고 시에만 정비 요청으로 승격** |
| 오탐 함정 | ① **공급압 효과** — 버퍼가 30→5 bar로 빠지는 동안 설정압이 등급에 따라 +3~219% 오른다(최대 오탐원) ② 온도 하강만으로도 압력은 떨어진다 ③ 안전밸브 심 미세누출과 신호가 같다 ④ 설정값 현장 재조정 ⑤ 출하·기동 직후 압력평형 20~30분 |
| 평가 게이트 | `\|ΔT_ambient\| < 1 °C`, 하류 격리 확인, 설정압 변경 이력 없음, **PT-202 스팬 ≤ 4 bar**(0~40 bar 전송기로는 40 mbar급 판정이 원리상 불가), PSV 미작동. 하류 체적이 밸브 구성에 따라 달라지므로 **'같은 격리 구성' 태그가 붙은 구간끼리만** 비교 |
| 기존 중복 | 없음. `tank.static_leak`은 고압 정지보유 누설이고 이건 저압 하류 크리프다 |

### 5.2 `hx.ua_drop` — 열교환기 성능 저하

| 항목 | 내용 |
|---|---|
| 대상 | `hx.recovery` |
| 입력 | `hx.temp.hot.in/out`, `hx.temp.cold.in/out` (4점 전부 필수), `hx.flow.hot`, `hx.flow.cold` (필수), `hx.pressure.diff.hot/cold` (권장) |
| 방법 | 정상상태 5분 창에서 `Q_cold = ṁ·cp·ΔT_cold`, `LMTD = (ΔT1−ΔT2)/ln(ΔT1/ΔT2)`, `UA = Q_cold/LMTD`. **유량 bin(±10%) × T_hot_in bin(±3 K)**별로 세정 직후 14일을 기준선으로 잡고 최근 7일 중앙값의 변화율을 본다. 차압 정규화값 `ΔP/(ΔP_ref·(Q/Q_ref)^1.75)`과의 동반 여부로 **판별 체크**: 차압도 오르면 스케일·막힘, 차압이 그대로면 표면 막 또는 유량 저하 |
| 임계 | 경고 −15% · 주의 −25% · 창 7일 · 기준 14일 · 최소 표본 200 · 차압 정규화 1.20 / 1.50 |
| 오탐 함정 | ① DI 탱크 수온의 계절 변동(LMTD 정규화 필수) ② VFD 감속 ③ **ΔΘ 10 K 미만 구간의 계측 오차 폭증** ④ 센서 쌍 드리프트 ⑤ **이 계통에서는 양측 열수지 절대값 검사를 쓰면 안 된다** — 설계상 Q_cold가 Q_hot의 약 7%라 상시 오경보가 난다. `Q_hot/Q_cold` **비의 변화**를 봐야 한다 |
| 평가 게이트 | 정상상태(5분 창 4개 온도의 `\|dT/dt\| < 0.2 K/min`), 최소 부하 `Q_cold ≥ 설계의 30%`, **양측 ΔΘ ≥ 10 K**. 근거는 국내 적산열량계 기술기준의 감온부 오차 `Et = ±(0.5 + 3·ΔΘmin/ΔΘ)%` — ΔΘ 15 K·ΔΘmin 3 K에서 ±1.1%지만 ΔΘ 5 K면 ±2.3%로 폭증한다. **1차측 유량계가 없으면 UA 대신 접근온도(`T_hot_in − T_cold_out`, 경고 +3 K / 주의 +5 K)로 대체**한다 |
| 기존 중복 | 없음 |

**함께 넣어야 하는 안전 가드 `hx.cross_leak`** (별도 탐지기 아닌 상시 체크로 둬도 된다): 25 °C 환산 전도도로 `Δσ = σ_하류 − σ_상류`. **σ_하류 > 1.0 µS/cm는 원인 불문 즉시 경보**(ASTM Type II — 수전해 스택 보호선). `Δσ > 0.3 µS/cm`이면서 1차측 보충수 주간 증가율 >20%면 '누설', 보충수 증가가 없으면 '316L 이온 용출'로 분류한다. **1차측 보충수 카운터가 없으면 이 판별 자체가 불가능**하므로 신설 요청에 포함했다. 게이트: `hx.flow.cold > 0.1 m³/h` AND `hx.temp.cold.out > 30 °C`(예열 실제 동작 중), 세정·수지 교체 후 72시간 억제.

### 5.3 `wtu.specific_water_rise` — 물 소비 원단위 상승

| 항목 | 내용 |
|---|---|
| 대상 | `h2.elz.water` |
| 입력 | `water.volume.total` (필수), `h2.mass.total` (필수), `water.flow.recycle`, `ac.power`@ELZ1 (부하율), `water.temp`, `start.count` |
| 방법 | 주 단위 `SWC = Δwater.volume.total[L] / Δh2.mass.total[kg]`를 **부하율 10% bin × 수온 bin**으로 정규화해 과거 동일 bin 중앙값과 비교. 상승분을 화학양론(8.93 고정) + 가스 반출 순손실(30 bar 기준 약 0.11) + 전처리 배출(회수율) + 물리 손실(잔차)로 분해하고, **기동 횟수를 설명변수로 넣은 회귀**로 기동 관련 손실을 분리한다 |
| 임계 | 기준 대비 +10%가 **4주 연속** · 주간 수소 생산 ≥100 kg · 물리 하한 8.93 L/kg · 도면값 11.13, 관리 상한 12.5 |
| 오탐 함정 | ① **분모(수소 적산) 신뢰도** — 분자보다 먼저 검증해야 한다 ② 기동 횟수 증가는 설비 고장이 아니라 운전 스케줄 문제다 ③ 계절 수온 ④ 운전 압력 변경(가스 반출 수분이 압력의 함수) ⑤ **외부 반입 수소가 분모에 섞이면 원단위가 가짜로 내려간다** |
| 평가 게이트 | **물리 하한 8.93 L/kg 미만이 나오면 경보가 아니라 DQ 이슈로 전환**한다(계측 오류). 주간 수소 생산량이 기준 미만인 주는 제외(분모가 작으면 비율이 폭주). **분모는 반드시 자체 생산 수소**이고 `h2.delivery.mass.total`을 뺀다 |
| 기존 중복 | `el.sec_rise`(전력 원단위)와 **구조는 같고 대상 자원만 다르다** — 같은 정규화·bin 코드를 재사용할 수 있다 |

### 5.4 `o2.recovery_drop` — 산소 회수율 저하 / 방출 손실 증가

| 항목 | 내용 |
|---|---|
| 대상 | `o2.plant` |
| 입력 | `h2.flow.mass`@`elz.out` (필수), `o2.flow.mass`@`production`/`loading`/`vent`, `o2.inventory`, `tank.pressure`@`o2` + `tank.temp`@`o2` (필수 — 재고 환산), `o2.shipped.mass.total`, `valve.open`@`o2.vent`, `o2.detector.pct`@`vent` |
| 방법 | 일 단위 수지 `이론생산 − 출하 − Δ재고 = 방출 + 누설`. 이론생산 `= Σ(수소 Nm³) × 0.5 × 1.429`. **회수율 = 출하 ÷ 이론생산**, **방출 손실률 = 잔차 ÷ 이론생산**. 동시에 **만재율**(탱크 압력이 상한 95%에 붙은 시간 ÷ 수전해 운전시간)을 추적해 두 지표의 상관이 0.7 이상이면 '구조적 버퍼 부족'으로 분류한다. 구현은 `h2chain-mass-balance.ts`와 같은 구조 |
| 임계 | 회수율 1단계 목표 60% / 최종 85% · 방출 손실률 경고 15% / 주의 30% · 만재율 경고 10% · 방출밸브 개도시간 비율 5% |
| 오탐 함정 | ① **FT-401이 없어 이론생산으로 대체하면 부하변동 오차가 그대로 들어온다** ② 출하 전표 미입력을 방출로 오인 ③ 계획 퍼지·정비 방출을 손실로 집계 ④ Z=1 근사는 15 bar에서도 약 1% 계통오차 ⑤ **온도 없이는 재고 환산 자체가 불가능** |
| 평가 게이트 | 수소 유량 커버리지 ≥90%인 날만 계산. 수전해 운전 2시간 미만인 날 제외. **FT-401이 없으면 결과에 `estimated=true`를 붙여 UI에서 점선으로 표시**하고 신뢰도 등급을 낮춘다. 계획 퍼지·정비 방출은 `asset_event`로 제외 |
| 기존 중복 | 없음. `tank.static_leak`과 `h2chain.mass_balance_gap`의 **코드는 재사용**하되 산소 EOS로 파라미터화한다 |

### 5.5 `h2.delivery.unlogged` — 반입 기록 누락

| 항목 | 내용 |
|---|---|
| 대상 | `h2.delivery` (없으면 사이트) |
| 입력 | `h2.inventory`@`buffer` 또는 `h2.pressure`+`tank.temp`, `h2.flow.mass`@`elz.out`, `h2.delivery.mass.total`, `om.h2_delivery` 레코드 |
| 방법 | 일별 원장에서 `stored_delta − produced > 시간당 최대 생산량 × 1.5`인 구간을 이벤트로 잘라내고, 같은 구간에 하역 적산 증가 또는 전표 레코드가 있는지 조인한다. 없으면 '기록 없는 재고 증가' finding |
| 임계 | 재고 급증 임계 = 정격 생산율 × 1.5 × 구간시간 · 이벤트 지속 ≥20분 |
| 오탐 함정 | ① **온도 보정 누락**(30 bar에서 30 K면 약 12 kg = 10%) ② 적산계 통신 결측 ③ 정비 후 질소 퍼지 ④ **자정 경계에 걸친 하역**(KST 일 귀속) |
| 평가 게이트 | 재고 환산에 온도가 있어야 한다(없으면 판정 불능). 전표 입력 마감 여유(예: 48시간)를 두고 그 전에는 발화하지 않는다 |
| 기존 중복 | `h2chain.mass_balance_gap@2`의 **하위 판별 체크로 넣어도 된다** — 별도 탐지기로 만들지, 체크로 붙일지는 구현 시 결정 |

### 5.6 `h2.buffer.autonomy` — 재고 가동여유 예보

| 항목 | 내용 |
|---|---|
| 대상 | `h2.storage.bank` |
| 입력 | `h2.inventory`@`buffer` (또는 압력+온도), `fc.h2.consumption`, `h2.flow.mass`@`elz.out`, `h2.trailer.inventory`(경계 설정에 따라), 반입 리드타임(사이트 설정) |
| 방법 | `runtime = (m − m_min) / (소비율 − 생산율)`. 태양광 예측·발전 계획으로 24시간 재고 궤적을 시뮬레이션해 **예보 알람**을 낸다 |
| 임계 | 여유 시간 < 반입 리드타임 × 2 → 경고 · < 리드타임 → 주의. `m_min`은 **감압밸브 최소 입구 차압**으로 정하고 공급압 효과 여유를 더한다 |
| 오탐 함정 | ① **재고 경계 정의**(체류 트레일러 포함 여부)로 값이 몇 배 달라진다 ② 계절 일사 미반영 ③ FC 출력 계획 변경 ④ 리드타임이 unknown이면 임계 자체가 없다 |
| 평가 게이트 | 재고 경계 버전이 바뀐 날은 판정 제외. 리드타임 미설정 사이트에서는 **경보 대신 정보 표시만** 한다 |
| 기존 중복 | 없음 |

### 5.7 우선순위와 선행 조건

| 순서 | 탐지기 | 선행 계기 | 왜 이 순서인가 |
|---|---|---|---|
| 1 | `hx.cross_leak` (가드) | CT-301 | **수전해 스택 전손을 막는 일**이라 절감 지표보다 먼저다 |
| 2 | `h2.delivery.unlogged` + 원장 `@2` | 전표 CSV만 있어도 가능 | 계기 없이 장부만으로 시작할 수 있다 |
| 3 | `prv.lockup_creep` | PT-202 스팬 재지정 | 계기 하나만 바꾸면 된다 |
| 4 | `o2.recovery_drop` | TT-401, FT-401/402 | 산소 사업 성립 여부 판단 자료가 된다 |
| 5 | `wtu.specific_water_rise` | FQ-101, FT-102 | 기준선 4주가 필요해 늦게 시작해도 된다 |
| 6 | `hx.ua_drop` | TT-304, FT-302, 차압 2점 | 계기가 가장 많이 필요하다 |

---

## 6. 새 KPI와 화면 반영 위치

`om.kpi_daily`에 적재하고, 화면은 기존 3곳(사이트 상세 / 체인 원장 / 리포트)에 나눠 넣는다. **새 화면은 §7의 공정도 하나만 만든다.**

| KPI 키 | 정의 | 목표·임계 | 화면 위치 |
|---|---|---|---|
| `h2.self.sufficiency` | 자체 생산 ÷ (생산 + 반입) | 도면 구조상 10~20%대 예상 | **사이트 상세 · 오늘 KPI 카드** (1급) |
| `h2.buffer.runtime` | (재고 − 하한) ÷ (소비율 − 생산율) [h] | 반입 리드타임의 2배 이상 | **사이트 상세 · 오늘 KPI 카드** (1급) |
| `h2.balance.residual.pct` | 원장 잔차율 (`@2` 식) | ±2% | 체인 원장 (기존 자리, 식만 교체) |
| `h2.delivery.reconcile.pct` | (전표 − 사이트계량) ÷ 전표 | ±1.5% (OIML 등급 2) | 체인 원장 · 반입 탭 |
| `h2.fuel.cost.per.mwh` | Σ(반입 kg × 단가) ÷ FC 발전량 | **단가 unknown — 확정 전까지 kg만 표시** | 월간 리포트 |
| `o2.recovery.ratio` | 출하 ÷ 이론생산 | 1단계 60%, 최종 85% | **사이트 상세 · 부산물 패널**(신규 패널 1개) |
| `o2.vent.loss.ratio` | (이론생산 − 출하 − Δ재고) ÷ 이론생산 | ≤15%, 추정값엔 '추정' 플래그 | 사이트 상세 · 부산물 패널 |
| `o2.tank.full.time.ratio` | 압력 ≥ 상한 95%인 시간 ÷ 수전해 운전시간 | ≤10% (압축기 투자 판단 근거) | 사이트 상세 · 부산물 패널 |
| `o2.purity.margin` | (2.0 − HTO%) ÷ 2.0 | ≥50%. **0%는 곧 압축·출하의 법적 금지** | 사이트 상세 · 부산물 패널 + 안전 화면 |
| `o2.quality.check.compliance` | 품질검사 기록일 ÷ 산소 제조일수 | **100% (법정 의무)** | 월간 리포트 · 준수 절 |
| `hx.ua.health` | 7일 중앙값 UA ÷ 기준 UA | ≥85% 정상 / 75~85% 경고 / <75% 세정 | 설비 상세(`FC1/HX1`) |
| `hx.approach.rise` | 7일 중앙값 접근온도 − 기준 | ≤+3 K (1차측 유량계 없을 때의 대체) | 설비 상세 |
| `chp.heat.recovery.ratio` | Σ회수 열량[kWh_th] ÷ Σ FC 발전량[kWh_e] | 도면 설계치 0.175 (문헌 CHP 0.7~1.0) | 월간 리포트 |
| `chp.availability` | (FC 운전 ∩ 수전해 운전) ÷ 수전해 운전시간 | **<30%면 열회수 설비 경제성 재검토** | 월간 리포트 |
| `elz.preheat.power.saved` | 예열 ON/OFF bin별 전력 중앙값 차 | **경보가 아니라 월간 '주장 검증기'** — 도면 주장 75 kW 대 물리 상한 23.3 kW | 월간 리포트 · 검증 절 |
| `water.swc` | Δ급수 적산[L] ÷ Δ자체생산 수소[kg] | 도면 11.13, 관리 상한 12.5, 물리 하한 8.93 | 설비 상세(`ELZ1/WTU1`) |
| `water.recycle.ratio` | Σrecycle ÷ (Σfeed + Σrecycle) | 도면값 37.5%. **정의를 고정하지 않으면 값이 두 배 달라진다** | 설비 상세 |
| `water.quality.margin` | (0.1 − 측정) ÷ 0.1 × 100 | >40% 정상. **물의 이론 하한 0.055 때문에 45%를 넘을 수 없다 — UI 주석 필수** | 설비 상세 |
| `polisher.life.remaining` | 시간 기준[일]과 통수량 기준[%] **병기** | 잔여 14일 또는 20% 미만이면 자재 발주 알림 | 설비 상세 + 조치 화면 |
| `ro.npf.index` | ASTM D4516 정규화 투과유량 지수 | ≥90% 정상, <70%면 표준 세정으로 회복 불가 | 설비 상세 |
| `prv.regulation.deviation` | bin 고정 median(\|P_out − P_set\|) ÷ P_set | EN 334 AC 등급 이내 | 설비 상세(`PRV1`) |
| `prv.creep.rate` | 무유량 hold 구간 기울기 [mbar/h] | 계측 불확실도 3σ 이하 | 설비 상세 |

### 6.1 화면 변경 요약

| 화면 | 파일 | 변경 |
|---|---|---|
| 사이트 상세 | `app/(console)/sites/[siteCode]/page.tsx` | 오늘 KPI 카드에 자급률·버퍼 가동여유 2개 추가, **부산물 산소 패널 1개 신규**, 공정도 링크 |
| 체인 원장 | `components/sites/chain-section.tsx`, `lib/chain/sankey.ts` | Sankey 공급측에 `delivered` 노드, 반입 탭(건별 전표-계량 대조 표) |
| 설비 상세 | `app/(console)/sites/[siteCode]/assets/[assetId]/page.tsx` | 클래스별 KPI 블록(HX·WTU·PRV) — 기존 렌더링 분기에 케이스 추가 |
| 리포트 | `components/reports/pack-panels.tsx` | 월간 팩에 열회수 검증 절·산소 준수 절 추가 |
| 안전 | `app/(console)/safety/page.tsx` | `O2_ENRICHED_ATMOSPHERE`·`HX_CROSS_LEAK`·`GROUNDING_FAULT` 이벤트 코드 수용 |
| 설정 | `app/(console)/settings/supply/` | **신규** — 반입·출하 전표 수기 입력 + CSV |
| 공정도 | `app/(console)/sites/[siteCode]/pid/` | **신규** — §7 |

---

## 7. 공정도(P&ID) 화면 사양

**목적**: 도면을 아는 사람(설계사·현장)과 콘솔을 보는 사람(운영자·대표)이 **같은 그림 위에서 같은 숫자를 본다**. 계통도가 아니라 **읽기 전용 상태판**이다 — 조작 기능은 넣지 않는다.

### 7.1 SVG 구조

정적 SVG 한 장 + 값만 갱신하는 구조. ECharts를 쓰지 않는다(도면 좌표가 고정이라 차트 라이브러리가 할 일이 없다).

```
<svg viewBox="0 0 1600 900" role="img" aria-label="가평 청정수소발전 공정도">
  <defs>  화살표 마커 5종(물질별), 패턴 2종(파선)
  <g id="zones">     구역 배경 박스 + 라벨 (전력 / 수소생산 / 저장·감압 / 발전 / 부산물 / 반입)
  <g id="flows">     흐름선 <path> — data-flow="h2|o2|power|water|heat"
  <g id="equipment"> 설비 박스 <g data-asset-code="ELZ1"> = rect + 이름 + 명판 요약
  <g id="tags">      계장 태그 버블 <g data-tag="PT-201" data-point="H2BUF1/h2.pressure@buffer">
  <g id="values">    실시간 값 <text data-point="…"> — 이 그룹만 갱신된다
  <g id="findings">  발견사항 배지 <g data-asset-code="…">
</svg>
```

**좌표(설비 박스, x/y/w/h)** — 도면의 좌→우 공정 순서를 그대로 옮겼다.

| 구역 | 설비 | x | y | w | h |
|---|---|---|---|---|---|
| 전력 | `PV1` 태양광 1.5 MWp | 60 | 80 | 150 | 70 |
| 전력 | `ESS1` ESS 2.0 MWh | 60 | 200 | 150 | 70 |
| 반입 | `H2DLV1` 외부 수소 반입 | 60 | 400 | 150 | 70 |
| 반입 | `H2DLV1/TRL*` 체류 트레일러 | 60 | 500 | 150 | 50 |
| 유틸리티 | `ELZ1/WTU1` 순수 제조설비 | 60 | 640 | 150 | 60 |
| 유틸리티 | `ELZ1/WTU1/TANK1` DI 물탱크 20 m³ | 60 | 740 | 150 | 60 |
| 수소생산 | `ELZ1` PEM 수전해 2.5 MW | 330 | 140 | 210 | 130 |
| 저장 | `H2BUF1` 버퍼 30 bar·50 m³ | 640 | 150 | 170 | 110 |
| 감압 | `PRV1` 감압밸브 30→0.8 bar | 890 | 170 | 130 | 70 |
| 발전 | `FC1` PEM 연료전지 2.0 MW | 1100 | 140 | 200 | 130 |
| 발전 | `FC1/HX1` 열교환기 HX-301 | 1100 | 330 | 200 | 70 |
| 전력변환 | `PCS1` PCS 2,500 kW | 1380 | 160 | 150 | 90 |
| 계통 | `MTR1` 계통 380 V→22.9 kV | 1380 | 320 | 150 | 70 |
| 부산물 | `O2P1/TANK1` O₂ 15 bar·30 m³ | 330 | 700 | 170 | 90 |
| 부산물 | `O2P1/LOAD1` 산소 출하 | 640 | 710 | 150 | 70 |

**흐름선**

| id | from → to | 색 | 선 |
|---|---|---|---|
| `f.pv.elz` | PV1 → ELZ1 | power | 실선 2.5 |
| `f.ess.elz` | ESS1 ⇄ ELZ1 | power | 실선 2.5 (양방향 마커) |
| `f.elz.buf` | ELZ1 → H2BUF1 | h2 | 실선 3 |
| `f.dlv.buf` | H2DLV1 → H2BUF1 | h2 | 실선 3 (**점선 테두리 = 도면에 없는 신설 제안**) |
| `f.buf.prv` | H2BUF1 → PRV1 | h2 | 실선 3 |
| `f.prv.fc` | PRV1 → FC1 | h2 | 실선 3 |
| `f.fc.pcs` | FC1 → PCS1 → MTR1 | power | 실선 2.5 |
| `f.fc.hx` | FC1 → HX1 (75 °C) | heat | 파선 3-3 |
| `f.hx.fc` | HX1 → FC1 (환수 60 °C) | heat | 파선 3-3 |
| `f.tank.hx` | DI탱크 → HX1 | water | 실선 2 |
| `f.hx.elz` | HX1 → ELZ1 (급수 55 °C) | water | 실선 2 |
| `f.elz.recycle` | ELZ1 → DI탱크 (회수수 0.3) | water | 파선 8-4 |
| `f.elz.o2` | ELZ1 → O2탱크 | o2 | 실선 2 |
| `f.o2.load` | O2탱크 → 출하 | o2 | 실선 2 |
| `f.o2.vent` | O2탱크 → 방출 | o2 | 파선 4-4 |

### 7.2 태그 ↔ 포인트 매핑 표 (화면이 쓰는 것)

| 태그 버블 | 앵커 좌표 | point (asset / metric @ qualifier) | 표시 | 소수 자리 |
|---|---|---|---|---|
| PT-201 | (735, 140) | `H2BUF1` / `h2.pressure`@`buffer` | `28.4 bar` | 1 |
| PT-202 | (1020, 160) | `FC1` / `h2.pressure`@`fc.inlet` | `0.81 bar` | 2 |
| PT-401 | (420, 690) | `O2P1/TANK1` / `tank.pressure`@`o2` | `12.6 bar` | 1 |
| FT-101 | (215, 670) | `ELZ1/WTU1` / `water.flow.feed` | `0.48 m³/h` | 2 |
| FT-201 | (555, 190) | `ELZ1` / `h2.flow.mass`@`elz.out` | `41.2 kg/h` | 1 |
| FT-301 | (1085, 190) | `FC1` / `fc.h2.consumption` | `118.6 kg/h` | 1 |
| TT-301 | (1200, 315) | `FC1/HX1` / `hx.temp.hot.in` | `74.1 °C` | 1 |
| TT-302 | (1305, 365) | `FC1/HX1` / `hx.temp.hot.out` | `60.3 °C` | 1 |
| TT-303 | (1085, 395) | `FC1/HX1` / `hx.temp.cold.out` | `54.8 °C` | 1 |
| LT-101 | (215, 770) | `ELZ1/WTU1/TANK1` / `water.tank.level` | `72 %` | 0 |
| **TT-201** ★ | (735, 265) | `H2BUF1` / `tank.temp`@`buffer.gas` | `18.2 °C` | 1 |
| **TT-401** ★ | (420, 795) | `O2P1/TANK1` / `tank.temp`@`o2` | `21.5 °C` | 1 |
| **AT-401** ★ | (500, 250) | `ELZ1` / `h2.in.o2`@`o2.product` | `0.42 %` | 2 |
| **CT-301** ★ | (1085, 420) | `FC1/HX1` / `water.conductivity`@`feed` | `0.08 µS/cm` | 3 |
| **FT-102** ★ | (215, 720) | `ELZ1/WTU1` / `water.flow.recycle` | `0.29 m³/h` | 2 |
| **FT-501** ★ | (215, 430) | `H2DLV1` / `h2.delivery.flow.mass` | `— kg/h` | 1 |

★ = 신설 요청 계기. **화면에는 처음부터 그리되 값 자리에 '미설치'로 표시**한다 — 그래야 도면을 보는 사람이 무엇이 빠졌는지 한눈에 본다. 전체 매핑은 시드(`db/seed/`)에서 읽어 만들고, 이 표는 **좌표만** 정의한다.

### 7.3 실시간 값 표시 규칙

| 상황 | 표시 | 판정 |
|---|---|---|
| 정상 | `28.4 bar` | 최근 완료 롤업 버킷의 마지막 값 |
| 지연 | `28.4 bar` + 회색 + 시각 툴팁 | 수집 지연 > `period_s × 3` |
| 결측 | `—` (연회색) | 최근 `period_s × 10` 안에 값 없음 |
| 고착 | `28.4 bar` + 고착 아이콘 | `flatline_max_s` 초과 (기존 `dq-gap-flatline` 판정 재사용) |
| 하드 범위 이탈 | `이상` (값 대신) | `hard_min`/`hard_max` 밖 — **틀린 값을 그대로 보여주지 않는다** |
| 포인트 미매핑 | `미매핑` (점선 테두리) | 시드에 태그는 있으나 `om.point` 없음 |
| 계기 미설치 | `미설치` (점선 테두리) | ★ 항목 |

- **갱신 주기 60초**. 서버 컴포넌트로 초기 렌더 후 `#values` 그룹만 교체한다. 폴링이지 스트리밍이 아니다(기존 콘솔에 실시간 채널이 없다).
- **단위는 항상 붙인다.** 정규 단위(`metric_def.unit`)로 환산된 값만 쓴다 — 벤더 원단위는 `point.scale`/`value_offset`이 이미 처리한다.
- **파생값(UA·접근온도·회수율)은 태그 버블이 아니라 설비 박스 하단 줄**에 둔다. 계측값과 계산값을 같은 모양으로 그리면 안 된다.

### 7.4 발견사항 강조 규칙

**흐름선은 물질 종류만 나타내고 상태를 나타내지 않는다.** 상태는 설비 박스와 배지로만 표현한다 — 흐름색(열=적橙)과 경보색(crit=적)이 겹치는 문제를 이 규칙 하나로 없앤다.

| 상태 | 설비 박스 | 배지 |
|---|---|---|
| 정상 | 테두리 `--rule` 1px | 없음 |
| 경고 발견사항 ≥1 | 테두리 `--warn` 2px + `--warn-fill` 배경 | 우상단 원형 배지, 숫자 = 열린 발견사항 수 |
| 주의 발견사항 ≥1 | 테두리 `--crit` 2.5px + `--crit-fill` 배경 | 같은 위치, `--crit` 색 |
| 안전 이벤트 진행 중 | 테두리 `--crit` 3px + 삼각 아이콘 | **배지와 별도** — 안전은 분석 결과와 섞지 않는다 (기존 안전 레인 정책) |
| 데이터 품질 문제 | 테두리 점선 | DQ 아이콘 |

- 배지 클릭 → `/desk?asset=<code>&status=open` 으로 이동(기존 데스크 필터 재사용).
- 설비 박스 클릭 → 설비 상세.
- **색만으로 상태를 전달하지 않는다** — 테두리 굵기·아이콘·배지 숫자가 항상 함께 간다(접근성).
- 애니메이션(흐름 점 이동 등)은 넣지 않는다. 60초 폴링 화면에서 흐름 애니메이션은 실시간이라는 잘못된 인상을 준다.

### 7.5 흐름선 범례와 색 토큰

| 흐름 | 토큰 | 라이트 | 다크 | 선 모양 |
|---|---|---|---|---|
| 수소 | `--flow-h2` = `var(--hydrogen)` | `#0c6674` | `#6cc6d3` | 실선 3px |
| 전력 | `--flow-power` = `var(--solar)` | `#9a5c00` | `#f0b54a` | 실선 2.5px |
| 산소 | `--flow-o2` **신규** | `#3f4fa8` | `#93a2ef` | 실선 2px |
| 물 | `--flow-water` **신규** | `#2c6e8f` | `#79bcd8` | 파선 8-4 |
| 열 | `--flow-heat` **신규** | `#b4571f` | `#f0a072` | 파선 3-3 |

범례는 SVG 하단 고정 위치(y 850)에 둔다. **다섯 흐름이 색과 선 모양 둘 다로 구분되므로 흑백 인쇄와 색각 이상에서도 읽힌다** — 리포트 인쇄 경로(`app/(print)/`)에 그대로 실린다.

---

## 8. 데이터 계약 추가 요청 항목 (벤더·설계사에게)

전체 표는 [`data-contract-draft.md` 부록 B](./data-contract-draft.md)에 넣었다. 여기에는 **왜 그 정확도가 필요한지**만 요약한다.

| 그룹 | 포인트 | 특히 중요한 것 | 정확도 요구의 근거 |
|---|---|---|---|
| B.1 부산물 산소 | 9 | TT-401, AT-401(HTO), FT-402(출하 적산) | 출하 적산 **±0.5%**는 상거래 계량이기 때문. HTO는 법정 압축금지선(2%) 판정용이라 분해능 0.05 vol% 필요 |
| B.2 폐열회수 | 7 | TT-304, CT-301, 적산열량계 | 온도 쌍은 **EN 1434 Class 2 정합 쌍(편차 0.1 °C 이내)** — 쌍이 안 맞으면 ΔT 15 K에서 오차가 곧바로 1%를 먹는다 |
| B.3 수처리 | 10 | CT-102(MBP 후단), FT-102, FQ-101 | MBP 후단 전도도는 **0.055~2 µS/cm 구간 분해능**이 필요하다. 교정은 100 µS/cm 표준액으로 하고 저농도 표준액은 쓰지 않는다 |
| B.4 감압·버퍼 | 7 | PT-202 스팬 재지정, TT-201, PLC 1초 압력통계 | PT-202를 0~40 bar로 두면 40 mbar급 판정이 **원리상 불가능**하다. 0~4 bar·≤0.075%FS로 바꿔야 한다 |
| B.5 외부 반입 | 7 | FT-501 코리올리, 접지 접점, 하역 상태 코드 | 반입 **±0.5%**가 아니면 잔차 임계 2%를 계량 오차가 다 먹는다(1.5%면 68% 소모) |
| B.6 명판·문서 | — | Nm³ 기준조건, 압력 기준(게이지/절대), HX 벽 구조·재질, 트레일러 명판, 감압 등급 | 숫자가 아니라 **해석의 기준**이다. 없으면 모든 계산이 가정 위에 선다 |
| B.7 장부(사람 입력) | — | 반입·출하 전표, 법정 품질검사 기록, 세정·수지 교체 이력 | 텔레메트리로 절대 오지 않는다. CSV 서식을 먼저 합의한다 |

> **요청 시점이 중요하다.** 계기 신설은 설계 단계에서만 싸다. 시공 후에는 배관 개조가 따라와 몇 배가 든다. 본 제안서의 포인트 40점(필수 29·권장 11)은 **REV.3 도면 확정 전에** 보내야 한다.

---

## 9. 작업 순서 제안

| 단계 | 작업 | 산출물 | 선행 |
|---|---|---|---|
| 1 | 데이터 계약 부록 B 송부, 발주처 Top 10 질의 | 회신 | — |
| 2 | 자산 클래스 10종 + 메트릭 54종 카탈로그 추가 | `db/seed/catalog.ts` + 시드 테스트 | — (질의와 병행 가능) |
| 3 | 가평 사이트 시드 + `SIM-D` 대조군 | `db/seed/sites.ts`, `templates-*.ts` | 2 |
| 4 | 원장 `@2`(+`delivered`) + `om.h2_delivery` + CSV 화면 | 마이그레이션 1, 서버 액션 2, 화면 1 | 2 |
| 5 | 공정도 화면 | `sites/[siteCode]/pid/` | 3 |
| 6 | 새 탐지기 6종 (§5.7 순서) | 탐지기 + 테스트 + 준비도 등록 | 3, 4 |
| 7 | KPI·리포트 절 추가 | `kpi_daily` 적재 + 리포트 팩 | 6 |

각 단계는 **기존 테스트가 통과한 상태로 끝난다**. 특히 2단계는 기존 사이트(SIM-A/B/C)의 준비도 점수가 바뀌지 않아야 한다 — 새 메트릭은 새 탐지기에만 걸리므로 바뀌면 그건 회귀다.

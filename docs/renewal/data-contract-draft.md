# 데이터 계약 초안 (리서치 기반)

메트릭 224개 — must 106 · should 89 · nice 29

> 2026-09-14 리서치 결과에서 자동 추출. 벤더·게이트웨이와 "어떤 데이터를 주고받을지" 협의할 때 출발점으로 쓴다.
> **must** = 핵심 탐지에 필수, **should** = 정확도·오탐 방지에 중요, **nice** = 있으면 좋음.
> 원본 전체(샘플 주기, 출처 프로토콜, 고장모드, 출처 URL)는 [research/](research/) 의 JSON 참고.

## 태양광 + ESS

### 기상관측 설비 `weather_station`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `poa_irradiance` | 경사면 일사량(POA) | W/m² | Class A 3초 샘플/1분 기록, 실무 1~5분 평균 | 0~1400 (구름 반사로 1000 초과 순간값 가능) | 일사계(ISO 9060) 또는 기준셀, RS485 Modbus RTU / SunSpec 302 |
| must | `module_temperature` | 모듈 후면 온도 | °C | 1분 | -20~85 | PT100/PT1000 후면 부착, SunSpec 303 |
| must | `ambient_temperature` | 외기 온도 | °C | 1분 | -25~40 (국내) | 기상센서 Modbus / 기상청 ASOS·동네예보 API |
| should | `ghi_irradiance` | 수평면 전일사량(GHI) | W/m² | 1분 | 0~1200 | 일사계 Modbus, 없으면 위성일사(추정치) API |
| should | `wind_speed` | 풍속 | m/s | 1분 | 0~30 | 풍속계 / 기상청 API |
| should | `relative_humidity` | 상대습도 | %RH | 1~10분 | 10~100 | 온습도센서 / 기상청 API (절연저항 해석용) |
| should | `rainfall_daily` | 일 강수량 | mm | 1시간/1일 | 0~300 | 우량계 / 기상청 API (오염 리셋 판정: ≥1mm/일) |
| nice | `snow_depth` | 적설 | cm | 1시간 | 0~50 | 기상청 API (적설 기간 분석 제외용) |

### MPPT 입력 채널 `mppt_input`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `dc_voltage` | MPPT 입력 전압(PV 전압) | V | 1~5분 | 200~1500 (시스템 최대전압 1000/1100/1500V) | SunSpec 160 DCV / 103 DCV, 제조사 Modbus 맵, REMS 'PV 전압' |
| must | `dc_current` | MPPT 입력 전류(PV 전류) | A | 1~5분 | 0~(스트링수×Isc, 스트링당 ~10~18) | SunSpec 160 DCA / REMS 'PV 전류' |
| must | `dc_power` | MPPT 입력 전력 | kW | 1~5분 | 0~인버터 정격×1.3 | SunSpec 160 DCW / 103 DCW |

### PV 스트링 `pv_string`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `string_current` | 스트링 전류 | A | 1~5분 | 0~18 | 접속반 CT(SunSpec 403 InDCA) 또는 스트링 인버터 스트링 전류 레지스터 |

### 접속반 `combiner_box`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| should | `combiner_bus_voltage` | 접속반 출력 전압 | V | 1~5분 | 200~1500 | SunSpec 403 DCV |
| should | `spd_fuse_status` | SPD/퓨즈 상태 | enum | 변화 시(이벤트) | 정상/동작/열화 | 접속반 DI 접점, SunSpec 403 Evt |
| nice | `combiner_temperature` | 접속반 내부 온도 | °C | 5분 | -20~70 | SunSpec 403 Tmp |

### 태양광 인버터(PCS) `inverter`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `ac_active_power` | 교류 유효전력(출력) | kW | 1분 | 0~정격(과부하 1.1배) | SunSpec 103 W / REMS '출력' |
| must | `ac_voltage_ll` | 교류 선간전압(상별) | V | 1분 | 380/400/480/800V 정격 ±10% | SunSpec 103 PPVphAB/BC/CA / REMS '출력전압' |
| must | `ac_current_phase` | 교류 상전류 | A | 1분 | 0~정격 | SunSpec 103 AphA/B/C / REMS '출력전류' |
| must | `grid_frequency` | 계통 주파수 | Hz | 1분 | 59.8~60.2 (정상) | SunSpec 103 Hz / REMS '주파수' |
| must | `energy_total` | 누적 발전량 | kWh | 5~15분 | 단조 증가 카운터 | SunSpec 103 WH / 122 ActWh / REMS '누적발전량' |
| must | `heatsink_temperature` | 방열판 온도 | °C | 1~5분 | 20~85 (70~80 부근 디레이팅 시작, 제조사별) | SunSpec 103 TmpSnk |
| must | `operating_state` | 운전 상태/고장 코드 | enum/bitfield | 변화 시 + 1분 폴링 | Off/Sleeping/Starting/MPPT/Throttled/Fault/Standby | SunSpec 103 St, Evt1, EvtVnd1~4 / REMS '고장여부' |
| must | `active_power_limit_setpoint` | 출력 제한 설정값(출력제어 지령) | % | 변화 시 | 0~100 | SunSpec 123 WMaxLimPct / 122 StActCtl, 중개사업자·KPX 지령 로그 |
| should | `ac_reactive_power` | 교류 무효전력 | kvar | 1~5분 | ±0.44×정격 | SunSpec 103 VAr |
| should | `power_factor` | 역률 | - | 1~5분 | 0.9~1.0 (지상/진상 설정) | SunSpec 103 PF / REMS '역률' |
| should | `cabinet_temperature` | 함체 내부 온도 | °C | 5분 | 0~60 | SunSpec 103 TmpCab (미제공 시 외부 센서 추가 권장 - NREL O&M) |
| should | `insulation_resistance` | 절연저항(Riso) | kΩ | 기동 시 1회/일 또는 연속 | 수백 kΩ~수 MΩ (야간/비운전 시 더 높음) | SunSpec 122 Ris(ohms) / 제조사 레지스터 |
| nice | `residual_current` | 누설(잔류)전류 | mA | 1분 | 0~300 | 제조사 Modbus 레지스터 |
| nice | `fan_status` | 냉각팬 상태/회전수 | rpm 또는 enum | 5분 | 0~수천 rpm | 제조사 레지스터(대부분 이벤트 비트로만 제공) |

### 계통연계/수배전 설비 `grid_interconnection`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `export_energy` | 송전(거래) 전력량 | kWh | 15분 | 15분 적산 | 한전 AMI 거래용 계량기 / 전력량계 Modbus(DLMS) |
| must | `relay_trip_event` | 보호계전기 동작(OCR/OCGR/OVR/UVR/OFR/UFR) | event | 이벤트 | - | 디지털 보호계전기 Modbus/DNP3, VCB 보조접점 |
| should | `aux_import_energy` | 수전(소내·보조) 전력량 | kWh | 15분 | 15분 적산 | 보조 전력량계 |

### 승압 변압기 `step_up_transformer`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| should | `transformer_top_oil_temperature` | 변압기 유온/권선온도 | °C | 5분 | 20~95 (경보 설정 통상 85~95, 추정) | 온도계전기 4-20mA → PLC/RTU |

### 배터리 뱅크(BBMS) `battery_bank`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `bank_voltage` | 뱅크(DC) 전압 | V | 1~10초 (DCIR용 ≤2초 권장) | 600~1500 | BMS CAN/Modbus TCP, SunSpec 802 V / REMS 충방전기 '전압' |
| must | `bank_current` | 뱅크 전류(부호: 충전 +) | A | 1~10초 (DCIR용 ≤2초) | ±(0.5~1C) | BMS 션트/홀센서, SunSpec 802 A / REMS '전류' |
| must | `soc` | 충전상태(SOC) | % | 10초~1분 | 운영 5~90 (옥내 80/옥외 90 제한 적용 설비) | BMS, SunSpec 802 SoC / REMS 'SOC' |
| must | `dc_insulation_resistance` | 배터리 DC 절연저항 | kΩ | 1분 | 수백 kΩ~MΩ (제조사 기준 이하 시 경보 의무) | 절연감시장치(IMD) Modbus |
| must | `bms_alarm_bits` | BMS 경보/보호 비트 | bitfield | 이벤트 + 10초 폴링 | - | SunSpec 802 Evt1/Evt2, 제조사 비트맵 |
| should | `soh_bms` | BMS 보고 SOH | % | 1시간~1일 | 70~100 | SunSpec 802 SoH / REMS 'SOH' (제조사 산식 비공개·계단식 → 독립 추정과 교차검증용) |
| should | `charge_current_limit` | 충전 전류 한계(CCL) | A | 10초~1분 | 0~정격 | BMS → PCS CAN (SunSpec 802 AChaMax) |
| should | `discharge_current_limit` | 방전 전류 한계(DCL) | A | 10초~1분 | 0~정격 | SunSpec 802 ADisChaMax |
| should | `dc_charge_energy_total` | DC 누적 충전량 | kWh | 1~15분 | 단조 증가 | BMS 적산 카운터 |
| should | `dc_discharge_energy_total` | DC 누적 방전량 | kWh | 1~15분 | 단조 증가 | BMS 적산 카운터 |
| nice | `cycle_count` | 사이클 수 | cycles | 1일 | 0~10000 | SunSpec 802 NCyc |

### 배터리 랙(RBMS) `battery_rack`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `rack_current` | 랙별 전류 | A | 1~10초 | ±랙 정격 | RBMS CAN/Modbus |
| must | `rack_voltage` | 랙별 전압 | V | 1~10초 | 600~1500 | RBMS |
| must | `cell_voltage_max` | 최고 셀 전압(+셀 위치 ID) | V | 1~10초 | LFP 2.5~3.65 / NMC 3.0~4.2 | SunSpec 803 CellVMax, CellVMaxMod/Stk |
| must | `cell_voltage_min` | 최저 셀 전압(+셀 위치 ID) | V | 1~10초 | LFP 2.5~3.65 / NMC 3.0~4.2 | SunSpec 803 CellVMin, CellVMinMod/Stk |
| must | `cell_voltage_avg` | 평균 셀 전압 | V | 1~10초 | LFP 3.2~3.35 평탄구간 | SunSpec 802 CellVAvg |
| must | `cell_temperature_max` | 최고 셀/모듈 온도(+위치) | °C | 10초~1분 | 15~45 (운전 권장 20~35) | SunSpec 803 ModTmpMax/ModTmpMaxMod / REMS 온도(최고) |
| must | `cell_temperature_min` | 최저 셀/모듈 온도(+위치) | °C | 10초~1분 | 15~40 | SunSpec 803 ModTmpMin / REMS 온도(최저) |
| must | `cell_temperature_avg` | 평균 셀/모듈 온도 | °C | 10초~1분 | 15~40 | SunSpec 803 ModTmpAvg / REMS 온도(평균) |
| should | `contactor_state` | 랙 접촉기 상태 | enum | 이벤트 | Open/Closed/Precharge | RBMS |

### 배터리 셀 `battery_cell`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| should | `cell_voltage` | 개별 셀 전압 배열 | V | 1분 (휴지 구간 스냅샷만이라도) | LFP 2.5~3.65 | MBMS → BMS 로컬 DB/HMI, 제조사 협의 필요 |
| nice | `balancing_active` | 셀 밸런싱 동작 여부/시간 | bool / s | 1분 | - | MBMS (제공 시 자가방전 이상 셀 탐지에 매우 유효) |

### 배터리 모듈(MBMS) `battery_module`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| should | `module_temperature_points` | 모듈별 온도 배열 | °C | 1분 | 15~45 | MBMS |

### ESS PCS(양방향 전력변환장치) `ess_pcs`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `pcs_dc_power` | PCS DC측 전력(전) | kW | 1~10초 | ±정격 | PCS Modbus / REMS (전)출력 |
| must | `pcs_ac_active_power` | PCS AC측 유효전력(후) | kW | 1~10초 | ±정격 | PCS Modbus / REMS (후)출력 |
| must | `pcs_ac_charge_energy_total` | AC 누적 충전 전력량 | kWh | 15분 | 단조 증가 | PCS 또는 양방향 전력량계 |
| must | `pcs_ac_discharge_energy_total` | AC 누적 방전 전력량 | kWh | 15분 | 단조 증가 | PCS 또는 양방향 전력량계 |
| must | `pcs_state_fault` | PCS 운전 상태/고장 | enum/bitfield | 이벤트 + 10초 | - | PCS Modbus / REMS '고장여부' |
| should | `pcs_ac_voltage` | PCS AC 전압 | V | 1분 | 정격 ±10% | PCS Modbus |
| should | `igbt_temperature` | IGBT/스택 온도 | °C | 1분 | 25~100 | PCS Modbus |

### 배터리실/컨테이너 환경 `battery_room`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `room_temperature` | 배터리실 온도 | °C | 1분 | 18~30 | 환경센서/HVAC 컨트롤러 Modbus |
| must | `room_humidity` | 배터리실 습도 | %RH | 1분 | 30~70 (결로 방지) | 환경센서 |
| must | `fire_detector_state` | 화재(연기/열) 감지기 상태 | enum | 이벤트 | 정상/경보 | 화재수신기 접점 |
| nice | `off_gas_concentration` | 오프가스(H2/CO/VOC) 농도 | ppm | 1~10초 | 0 (정상) | 가스감지기 4-20mA/Modbus |

### 공조기(HVAC) `hvac_unit`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `hvac_status` | 공조기 운전/압축기 상태 | enum | 이벤트 + 1분 | Off/Cool/Heat/Fault | HVAC 컨트롤러 Modbus |
| should | `hvac_supply_air_temperature` | 공조 토출 공기 온도 | °C | 1분 | 12~25 | HVAC 컨트롤러 |
| should | `hvac_return_air_temperature` | 공조 흡입(환기) 공기 온도 | °C | 1분 | 20~35 | HVAC 컨트롤러 |
| should | `hvac_power` | 공조 소비전력 | kW | 1~15분 | 0~수 kW(컨테이너당) | 보조전력 계량기/CT |

### RTU/데이터로거 `data_logger_rtu`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `comm_status` | 통신 상태/마지막 수신 시각 | s | 1분 | - | 수집 서버 측 산출(heartbeat) |

### 안전 인터록 (분석과 무관하게 즉시 알람)

- ESS 화재 감지기(연기/열) 동작 또는 소화설비 방출 신호 → 분석 파이프라인 우회, 즉시 최상위 알림
- 오프가스(H2/CO/전해액 VOC) 감지기 경보(제조사·감지기 설정값) → 즉시 알림
- 셀 온도 BMS 차단 한계 도달(예 LFP 55~60°C, 제조사값) 또는 셀 온도 상승률 > 1°C/min(추정) → 즉시 알림
- 셀 전압 상한/하한 초과(예 LFP > 3.65V 또는 < 2.5V, NMC > 4.25V 또는 < 2.8V, 제조사값) 2샘플 이상
- BMS 보호동작·명령 없는 접촉기 개방, 비상정지(E-stop) 동작(KEC: 자동 비상정지 5초 이내 동작 요구)
- 배터리 DC 절연저항이 제조사 기준 미만(KEC: 경보 및 자동 차단 요구)
- PV 인버터 절연저항 < Vmax/30mA(IEC 62109-2) 또는 지락/아크(AFCI) 경보
- 잔류전류 급변 30mA/60mA/150mA 스텝(0.3/0.15/0.04초 트립 기준) 또는 연속 300mA(≤30kVA) 트립 기록
- ESS SOC 운영 상한 초과(기존 설비 옥내 80%/옥외 90%, 신규 설비는 보증수명제도 설정값)
- 배터리실 온도 설계 상한 초과(예 35°C, 추정) 또는 습도 과다(결로 위험)이면서 HVAC 정지/고장
- 보호계전기 트립(OCR/OCGR/OVR/UVR/OFR/UFR)·VCB 개방
- 변압기 온도 2단 경보·부흐홀츠 계전기 동작
- ESS 통신 두절(안전 상태 불명) N분 이상(예 5분, 추정) → 운영자 즉시 확인 요청

## 수전해(전해조)

### 전해조 시스템(패키지/컨테이너) `electrolyzer_system`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `operating_state` | 운전 상태(정지/퍼지/냉간대기/온간대기/램프/생산/트립) | enum | 상태변화 시 + 1 s |  | 전해조 PLC(OPC UA 또는 Modbus TCP) |
| must | `power_setpoint` | 전력/전류 설정값(EMS→PLC) | kW | 1 s |  | 사이트 EMS/PLC |
| must | `ac_power_total` | 시스템 총 수전전력(BoP 포함) | kW | 1 s(저장 1분 평균) |  | 전력량계 Modbus |
| must | `ac_energy_total` | 누적 수전전력량 | kWh | 1 min |  | 전력량계 Modbus |
| must | `h2_mass_flow` | 수소 생산 유량(정제기 후) | kg/h | 1 s | 1 MW급 약 18~20 kg/h(≈200 Nm3/h) 정격 | 열식/코리올리 유량계 4-20 mA→PLC |
| must | `h2_total_produced` | 누적 수소 생산량 | kg | 1 min |  | 유량계 적산/PLC |
| must | `h2_outlet_pressure` | 수소 출구 압력 | bar(g) | 1 s | AWE 1~30, PEM 1~30(고압형 최대 ~70) | 압력전송기→PLC |
| must | `trip_alarm_code` | 트립/알람 코드 | enum | 이벤트 |  | PLC 알람 로그 |
| should | `pv_direct_power` | 태양광 직접 공급 전력 | kW | 1 min |  | EMS(청정수소 인증용 전력원 추적) |
| should | `grid_import_power` | 계통 수전 전력(전해조분) | kW | 1 min |  | EMS/계량기 |
| should | `h2_mass_flow_pre_dryer` | 수소 유량(건조기 전) | kg/h | 1 s |  | PLC(있을 경우) — 건조기 재생 손실 분리용 |
| should | `start_count` | 누적 기동 횟수 | count | 변화 시 |  | PLC 카운터(없으면 이벤트에서 파생) |
| should | `ambient_temperature` | 외기 온도 | °C | 1 min |  | 사이트 기상센서/OpenWeather |

### 전해 스택 `electrolyzer_stack`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `stack_current` | 스택 전류 | A | 1 s |  | 정류기 DC 전류센서(Modbus/Profinet)→PLC |
| must | `stack_voltage` | 스택 전압 | V | 1 s |  | 정류기/PLC |
| must | `stack_temp_outlet` | 스택 출구 온도(물/전해액) | °C | 1 s | PEM 50~80, AWE 70~90 | RTD→PLC |
| must | `stack_temp_inlet` | 스택 입구 온도 | °C | 1 s |  | RTD→PLC |
| must | `cathode_pressure` | 수소측(캐소드) 압력 | bar(g) | 1 s |  | PLC |
| must | `differential_pressure` | 양극간 차압 | bar | 1 s | 균압형 ≈0, 차압형 PEM 수~30 | 차압전송기→PLC |
| must | `stack_run_hours` | 스택 누적 운전시간(교체 시 리셋) | h | 1 min |  | PLC 또는 파생(전류>최소값 시간 적산) |
| should | `anode_pressure` | 산소측(애노드) 압력 | bar(g) | 1 s |  | PLC |
| nice | `insulation_resistance` | 절연저항/누설전류 | kΩ | 1 min |  | 절연감시장치 |

### 셀(또는 CVM 셀그룹) `electrolyzer_cell`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `cell_voltage` | 셀(그룹) 전압 | V | 1 s 수집, 저장은 1분 mean/min/max | PEM 1.4~2.5, AWE 1.4~3.0 (셀당) | CVM(CAN/Modbus), mV 분해능 |

### 정류기(변압기+AC/DC 변환) `rectifier`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `rectifier_ac_power` | 정류기 AC 입력전력 | kW | 1 s |  | 정류기 제어기 Modbus/Profinet |
| should | `rectifier_dc_power` | 정류기 DC 출력전력 | kW | 1 s |  | 정류기(없으면 V×I 파생) |
| should | `power_factor` | 역률 | ratio | 1 min | 0.85~0.99(추정, 토폴로지·부하 의존) | 전력분석기 |
| should | `current_thd` | 입력전류 THD | % | 1 min |  | 전력분석기 |
| should | `rectifier_heatsink_temp` | 정류소자 방열판/냉각수 온도 | °C | 10 s |  | 정류기 |
| should | `transformer_temp` | 변압기 권선/유온 | °C | 1 min |  | 변압기 온도계 |
| nice | `dc_ripple` | DC 전류 리플 | % | 1 min | 제조사 사양(수 % 이하, 추정) | 정류기 진단값 |

### 순수 제조기(RO/EDI/혼상 이온교환) `water_treatment_unit`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `di_product_conductivity` | 순수 제조기 출구 전도도 | µS/cm | 10 s | PEM: ≤1(ASTM Type II), 목표 <0.1(>10 MΩ·cm) | 전도도계 4-20 mA(온도보상 25 °C) |
| should | `ro_permeate_conductivity` | RO 투과수 전도도 | µS/cm | 1 min | 1~20(추정) | 순수기 PLC |
| should | `makeup_water_volume` | 보충수 누적 유량 | m3 | 1 min |  | 유량계 적산 |
| nice | `toc` | 총유기탄소(TOC) | ppb | 15 min~주간 샘플 | <50 | 온라인 TOC 분석기/실험실 |

### PEM 순환수(애노드) 루프 `water_loop_pem`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `loop_conductivity` | 순환수 전도도(이온교환기 전) | µS/cm | 10 s | <0.1~1 | PLC |
| must | `ix_outlet_conductivity` | 루프 이온교환기 출구 전도도 | µS/cm | 10 s | <0.1 | PLC |
| must | `anode_water_flow` | 애노드 순환수 유량 | m3/h | 1 s |  | PLC |
| should | `water_pump_power` | 순환펌프 전력/속도 | kW | 10 s |  | VFD Modbus |
| nice | `fluoride_concentration` | 배출수 불소이온 농도 | µg/L | 주 1회 샘플(또는 온라인 IC) |  | 실험실 분석 수기 입력 |

### AWE 전해액(KOH) 순환 루프 `lye_loop_awe`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `lye_flow` | 전해액 순환 유량 | m3/h | 1 s |  | PLC |
| should | `koh_concentration` | KOH 농도 | wt% | 1 min 또는 주기 샘플 | 25~30 | 밀도/전도도 기반 농도계, 실험실 |
| nice | `lye_filter_dp` | 전해액 필터 차압 | kPa | 1 min |  | PLC |

### 기액분리기(수소측/산소측) `gas_liquid_separator`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `h2_separator_level` | 수소측 분리기 레벨 | % | 1 s |  | 레벨전송기→PLC |
| must | `o2_separator_level` | 산소측 분리기 레벨 | % | 1 s |  | 레벨전송기→PLC |

### 가스 분석기 `gas_analyzer`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `h2_in_o2` | 산소 중 수소 농도(HTO) | %vol | 1~5 s | 정상 <1(부분부하에서 상승), 비상정지 >2 | 열전도식 분석기 4-20 mA→PLC |
| must | `o2_in_h2` | 수소 중 산소 농도(정제 전, OTH) | %vol | 1~5 s | 정상 수백 ppm~0.5 %(추정), 비상정지 >3 | 분석기→PLC |
| should | `o2_in_h2_product` | 정제 후 수소 중 미량 산소 | µmol/mol | 10 s | ≤5(ISO 14687 Grade D) | 전기화학/미량산소 분석기 |
| should | `h2_dew_point` | 제품 수소 이슬점 | °C | 10 s | ≤ -65 ~ -70(H2O ≤5 µmol/mol) | 세라믹 금속산화물 이슬점계 |
| should | `analyzer_health` | 분석기 상태/최종 교정일 | enum | 변화 시 |  | PLC/CMMS |

### 수소 정제기(Deoxo+건조기) `h2_purifier`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| should | `deoxo_inlet_temp` | Deoxo 입구 온도 | °C | 10 s |  | PLC |
| should | `deoxo_outlet_temp` | Deoxo 출구 온도 | °C | 10 s |  | PLC |
| should | `dryer_active_tower` | 건조기 흡착/재생 탑 상태 | enum | 변화 시 |  | 정제기 PLC |
| should | `dryer_regen_temp` | 건조기 재생 온도 | °C | 10 s | 150~250(추정, 흡착제 의존) | 정제기 PLC |
| nice | `dryer_heater_power` | 재생 히터 전력 | kW | 10 s |  | 정제기 PLC |

### 냉각계통 `cooling_system`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `coolant_supply_temp` | 냉각수 공급 온도 | °C | 10 s |  | PLC |
| should | `coolant_return_temp` | 냉각수 환수 온도 | °C | 10 s |  | PLC |
| should | `coolant_flow` | 냉각수 유량 | m3/h | 10 s |  | PLC |
| should | `hx_valve_position` | 냉각 제어밸브 개도 | % | 10 s |  | PLC |

### 안전계통 `safety_system`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `enclosure_h2` | 외함 내 수소 농도 | %vol | 1 s | 정상 ≈0, 비상정지 >1 | 방폭 수소검지기→안전PLC |
| must | `estop_status` | 비상정지/로크아웃 상태 | enum | 변화 시 |  | 안전PLC |
| should | `ventilation_status` | 환기장치 상태/풍량 | enum | 변화 시 |  | PLC |
| should | `n2_purge_pressure` | 질소 퍼지 공급 압력 | bar(g) | 1 min |  | PLC |
| should | `shutoff_valve_cycle_count` | 자동차단밸브 개폐 횟수 | count | 변화 시 |  | PLC(KGS AH271 부록 C3 기록 의무) |

### 안전 인터록 (분석과 무관하게 즉시 알람)

- KGS AH271 3.3.1.2 비상정지: 발생 산소 중 수소 농도 > 2 %vol
- KGS AH271 3.3.1.2 비상정지: 발생 수소 중 산소 농도 > 3 %vol
- KGS AH271 3.3.1.2 비상정지: 압축기로 공급되는 수소 중 산소 농도 > 2 %vol
- KGS AH271 3.3.1.2 비상정지: 외함 내 수소 농도 > 1 %vol
- KGS AH271 3.3.1.2 비상정지: 셀/스택 공급전압 이상, 온도 현저한 상승, 과전류, 안전성능 변화를 유발하는 차압
- KGS AH271 3.3.1.2 비상정지: 수용액 수위 과고/과저, 물·수용액 유량 현저한 저하, 수용액·산소·수소 계통 압력 현저한 상승, 환기장치 이상, 설비 내 온도 이상, 수소정제장치 이상(공급가스 압력·온도·조성·유량 경보치 초과, 제어밸브 장애, 전원 차단, 압력용기 허용치 초과)
- 비상정지 후 로크아웃 — 수동 해제 시에만 정상운전 복귀, 수전 회로 복전 후에도 자동 재가동 금지(KGS AH271)
- 기동 전 외함 공기/질소 퍼지 완료 및 모든 안전장치 정상일 때만 기동 허용(KGS AH271 3.3.1.1)
- 자동차단밸브 개폐 횟수가 제조사 제시값의 85% 초과 시 경보, 90% 초과 시 기동 금지(KGS AH271 부록 C3)
- 압축기 흡입압력 저하/토출 압력·온도 초과/윤활유 부족 시 압축기 정지·공급 차단(KGS AH271 3.3.2.5.4)
- CVM 셀전압 상·하한 이탈 시 정지(설정값은 제조사 사양)
- 제품 수소 품질(ISO 14687 Grade D: O2 ≤5 µmol/mol, H2O ≤5 µmol/mol, 순도 ≥99.97%) 이탈 시 저장·연료전지 공급 차단/격리(운영 설정, 법정 인터록 아님)
- 설계 원칙: 위 인터록은 현장 PLC/안전PLC가 실행하며 콘솔 분석 파이프라인(집계·추세·배치)을 절대 거치지 않는다. 콘솔은 원시 알람을 수신 즉시 푸시·기록만 하고, 통신 두절 또는 분석기 고장 시 해당 설비를 '안전 데이터 불확실' 상태로 표시한다.

## 수소 저장·압축 + 연료전지

### 수소 압축기(다이어프램/유압피스톤/왕복동) `h2_compressor`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `suction_pressure` | 흡입 압력 | bar(g) | 1~10 s | 10~40 bar(g) (수전해 출구, 추정) | 압축기 PLC Modbus TCP / OPC UA |
| must | `discharge_pressure` | 최종 토출 압력 | bar(g) | 1~10 s | 200~500 bar(g) 정치 저장, 최대 900~1000 bar(g) | 압축기 PLC |
| must | `discharge_temperature` | 단별 토출 가스 온도 | °C | 1~10 s | 설계 120~135 °C 이하(API 618 수소 과다 서비스), 다이어프램형은 보통 더 낮음(추정) | 압축기 PLC |
| must | `motor_power` | 구동모터 유효전력 | kW | 1~10 s | 정격 이내 | 전력량계/인버터 Modbus |
| must | `diaphragm_leak_detect_pressure` | 다이어프램 누설검지 포트 압력/스위치 | bar(g) | 1 s (상태변화 이벤트) | 정상 ≈ 0(대기), 상승 시 파손 | 압력스위치 → PLC 인터록 |
| must | `run_state` | 운전 상태(정지/기동/운전/트립)와 트립 코드 | enum | 상태변화 이벤트(ms 타임스탬프) | - | 압축기 PLC |
| must | `operating_hours` | 누적 운전시간 | h | 1 h | - | 압축기 PLC 카운터 |
| should | `interstage_pressure` | 단간(중간단) 압력(단별) | bar(g) | 1~10 s | 설계 압력비에 따름(단당 압력비 약 2~4, 추정) | 압축기 PLC |
| should | `suction_temperature` | 흡입 가스 온도 | °C | 10 s | 10~40 °C | 압축기 PLC |
| should | `cooling_water_inlet_temperature` | 압축기 냉각수 입구 온도 | °C | 10 s | 15~35 °C | 압축기 PLC |
| should | `cooling_water_outlet_temperature` | 압축기 냉각수 출구 온도 | °C | 10 s | 입구 대비 +3~10 °C(추정) | 압축기 PLC |
| should | `motor_current` | 구동모터 상전류(3상) | A | 1~10 s | 정격 이내, 상불평형 < 5%(추정) | 모터 인버터/보호계전기 |
| should | `motor_speed` | 모터/크랭크 회전수 | rpm | 10 s | 120~1,800 rpm(왕복동), 고정속 또는 VFD | 모터 인버터 |
| should | `h2_mass_flow` | 압축기 토출 수소 질량유량 | kg/h | 1~10 s | 설비 용량(수~수백 kg/h) | 코리올리 유량계; 없으면 저장뱅크 재고변화로 추정 |
| should | `vibration_velocity_rms` | 진동 속도 RMS(프레임/실린더) | mm/s | 엣지에서 1~10 kHz 수집 → 1 min RMS 전송 | ISO 20816-8 zone 경계 예 7.1/14/28 mm/s (측정 위치별 상이, 원문 확인 필요) | 진동 트랜스미터 4-20 mA / 무선 진동센서 |
| should | `hydraulic_oil_pressure_max` | 사이클별 유압(오일) 최대압(다이어프램) | bar(g) | 엣지 kHz 샘플 → 1 min max/min/mean | 가스 토출압보다 약간 높음(리밋밸브 설정) | 오일 압력센서 + 엣지 수집기 |
| should | `hydraulic_oil_temperature` | 유압유/윤활유 온도 | °C | 10 s | 40~70 °C(추정) | 압축기 PLC |
| should | `lube_oil_pressure` | 윤활유 공급압 | bar(g) | 1~10 s | 제조사 설정 | 압축기 PLC |
| nice | `valve_cover_temperature` | 밸브 커버 온도(밸브별) | °C | 10~60 s | 동일 단 밸브 간 편차 수 °C 이내(정상, 추정) | 추가 RTD/열전대 → PLC 또는 IoT 게이트웨이 |
| nice | `cooling_water_flow` | 압축기 냉각수 유량 | L/min | 10 s | 설계치 | 압축기 PLC |
| nice | `bearing_temperature` | 베어링/크로스헤드 온도 | °C | 10~60 s | < 80~90 °C(추정) | 압축기 PLC |
| nice | `hydraulic_oil_pressure_min` | 사이클별 유압 최소압(다이어프램) | bar(g) | 1 min 통계 | 흡입 과정 최저압 | 엣지 수집기 |
| nice | `packing_vent_h2_concentration` | 패킹 벤트 수소 농도/유량(피스톤형) | vol% | 10~60 s | 기준 대비 추세 | 벤트 라인 검지기/유량계 |

### 고압 수소 저장뱅크 `h2_storage_bank`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `tank_pressure` | 저장뱅크(용기군) 압력 | bar(g) | 1~10 s (정지유지 구간 1 min 이상도 가능) | Type I/II 약 200~450 bar, Type III/IV 350~700 bar | 압력 전송기 → PLC Modbus/OPC UA |
| must | `tank_wall_temperature` | 용기 표면 온도 | °C | 10~60 s | 외기±일사 영향 | 표면 RTD/열전대 |
| must | `ambient_temperature` | 외기 온도 | °C | 1 min | -20~40 °C | 현장 기상센서 또는 날씨 API(보조) |
| must | `inlet_valve_state` | 뱅크 인입 차단밸브 상태 | enum(open/closed) | 상태변화 이벤트 | - | 리밋스위치 → PLC |
| must | `outlet_valve_state` | 뱅크 인출 차단밸브 상태 | enum(open/closed) | 상태변화 이벤트 | - | 리밋스위치 → PLC |
| should | `tank_gas_temperature` | 용기 내부 가스 온도 | °C | 10 s | -40~85 °C(복합재 용기 일반 한계) | 용기 내부 온도센서(있을 때) |

### 수소 공급 밸브·레귤레이터 계통 `h2_valve_train`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `regulator_outlet_pressure` | 레귤레이터 출구 압력 | bar(g) | 1 s | 중압 5~20 bar(g) 등 설계치(추정) | PLC |
| must | `h2_supply_flow` | 연료전지 공급 수소 질량유량 | kg/h | 1~10 s | 정격 출력 기준 약 60~75 kg/MWh 상당 | 열식/코리올리 질량유량계 |
| must | `esv_command` | 자동차단밸브 개폐 명령 | enum | 이벤트(ms) | - | PLC/SIS 이벤트 로그 |
| must | `esv_limit_switch` | 자동차단밸브 리밋스위치(개/폐 도달) | enum | 이벤트(ms) | - | PLC/SIS 이벤트 로그 |
| should | `regulator_inlet_pressure` | 레귤레이터 입구 압력 | bar(g) | 1~10 s | 저장압 | PLC |
| nice | `filter_differential_pressure` | 수소 필터 차압 | kPa | 1 min | 설계치 | 차압계 |
| nice | `instrument_air_pressure` | 계장공기(밸브 구동) 압력 | bar(g) | 1 min | 5~7 bar(g)(추정) | PLC |

### 수소 가스 누출 검지기 `h2_gas_detector`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `h2_concentration` | 수소 농도 | ppm | 1 s (경보는 즉시 이벤트) | 배경 수~수십 ppm(추정), 경보 ≤ 10,000 ppm(1 vol%) | 검지기 4-20 mA → 가스 수신반/PLC, Modbus |
| must | `detector_fault_status` | 검지기 고장/보수 상태 | enum | 이벤트 | - | 가스 수신반 |
| should | `calibration_as_found_error` | 교정 시 교정 전 오차(as-found) | ppm | 교정 시(3~6개월) | 허용오차 이내 | 정비 기록 입력(수기/모바일) |

### 화염 감지기(UV/IR) `flame_detector`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `flame_detected` | 화염 감지 | bool | 이벤트(즉시) | - | 화재수신반/SIS |

### 수소 안전계통(검지·차단·환기) `h2_safety_system`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `esd_state` | 비상정지(ESD) 상태·원인 | enum | 이벤트(ms) | - | SIS/PLC 이벤트 로그 |
| must | `ventilation_status` | 환기팬 운전/풍량 스위치 | enum | 이벤트 + 1 min | - | PLC |

### 연료전지 발전 시스템 `fuel_cell_system`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `net_ac_power` | 순 송전 출력(AC) | kW | 1~10 s | 0~정격 | FCU Modbus TCP / 전력량계, IEC 61850-7-420 DFCL |
| must | `operating_state` | 운전 상태(정지/기동/발전/정지절차/트립)·고장코드 | enum | 상태변화 이벤트(ms) | - | FCU |
| must | `start_count` | 누적 기동 횟수 | count | 이벤트 | - | FCU 카운터(없으면 상태 이벤트로 산출) |
| must | `h2_inlet_pressure` | 시스템 수소 입구 압력 | bar(g) | 1 s | 설계치(수 bar, 추정) | FCU |
| should | `bop_power` | 보조기기(BOP) 소비전력 | kW | 10 s | 스택 출력의 5~20%(추정) | FCU / 서브미터 |

### 연료전지 스택 `fc_stack`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `stack_voltage` | 스택 전압 | V | 1 s | 셀수 × 0.6~0.8 V(정격), OCV 셀당 0.95~1.0 V | FCU / DC-DC 컨버터, IEC 61850-7-420 DSTK |
| must | `stack_current` | 스택 전류 | A | 1 s | 0~정격(전류밀도 약 0.3~1.2 A/cm², 정치형은 낮은 편, 추정) | FCU / DC-DC 컨버터 |
| must | `cell_voltage` | 개별 셀(또는 셀그룹) 전압 배열 | V | CVM 1 s 내부, 저장은 10 s~1 min 스냅샷 + 이벤트 시 1 s | 0.6~0.8 V 운전, < 0.3 V 경고/차단, 음전압=역전 | CVM (CAN 또는 FCU 경유 Modbus) |
| must | `cell_voltage_min` | 최저 셀전압 | V | 1 s | > 0.5 V 정상 운전(추정) | CVM |
| must | `cell_voltage_min_index` | 최저 셀 번호 | index | 1~10 s | 1~N | CVM |
| must | `stack_temperature` | 스택 온도(보통 냉각수 출구) | °C | 1~10 s | PEMFC 60~80 °C | FCU |
| should | `cell_voltage_std` | 셀전압 표준편차 | mV | 10 s | 수~20 mV(정상, 추정) | CVM 또는 콘솔 계산 |
| should | `anode_inlet_pressure` | 애노드 입구 압력 | kPa(a) | 1 s | 약 120~250 kPa(a)(추정) | FCU |
| should | `cathode_inlet_pressure` | 캐소드 입구 압력 | kPa(a) | 1 s | 상압~250 kPa(a)(추정) | FCU |
| should | `cathode_differential_pressure` | 캐소드 입출구 차압 | kPa | 1~10 s | 설계치(수~수십 kPa, 추정) | FCU |
| should | `insulation_resistance` | 절연저항(스택·DC 버스 대지) | kΩ | 1 min | 제조사 기준(차량 참고치 100 Ω/V DC 이상) | 절연감시장치(IMD) |
| nice | `hfr` | 고주파 저항(HFR) | mΩ·cm² | 1 min | 약 50~150 mΩ·cm²(추정) | 컨버터 리플 기반 또는 임피던스 측정기 |
| nice | `anode_differential_pressure` | 애노드 입출구 차압 | kPa | 1~10 s | 설계치 | FCU |

### 공기극(공기) 공급 계통 `fc_cathode_subsystem`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `air_mass_flow` | 공기 질량유량 | kg/h | 1 s | 공기 스토이키 1.5~2.5 상당(추정) | FCU 유량계 |
| should | `blower_speed` | 블로워 회전수 | rpm | 1~10 s | 설계치 | 블로워 인버터 |
| should | `blower_power` | 블로워 소비전력(또는 전류) | kW | 1~10 s | BOP 최대 항목 | 블로워 인버터 |
| nice | `air_filter_differential_pressure` | 흡입 공기필터 차압 | Pa | 1 min | 교체 기준 제조사 설정 | 차압계 |
| nice | `cathode_inlet_dewpoint` | 캐소드 입구 이슬점/상대습도 | °C | 10 s | 스택온도 대비 설계치 | 습도센서 |

### 연료극(수소) 공급 계통 `fc_anode_subsystem`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| should | `purge_valve_state` | 퍼지 밸브 개폐 | enum | 이벤트(ms) | 수 초~수 분 간격(추정) | FCU 이벤트 로그 |
| should | `recirculation_pump_speed` | 수소 재순환 펌프 회전수 | rpm | 1~10 s | 설계치 | FCU |
| should | `recirculation_pump_current` | 수소 재순환 펌프 전류 | A | 1~10 s | 설계치 | FCU |
| should | `exhaust_h2_concentration` | 배기 수소 농도 | vol% | 1 s | 희석 후 수 vol% 미만(차량 GTR13: 3초 평균 4%, 순간 8%) | 배기 수소센서 |
| nice | `drain_valve_state` | 물 드레인 밸브 개폐 | enum | 이벤트 | - | FCU |

### 냉각 계통 `fc_thermal_subsystem`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `coolant_inlet_temperature` | 스택 냉각수 입구 온도 | °C | 1~10 s | 55~75 °C(추정) | FCU |
| must | `coolant_outlet_temperature` | 스택 냉각수 출구 온도 | °C | 1~10 s | 입구 대비 +3~10 °C | FCU |
| should | `coolant_flow` | 냉각수 유량 | L/min | 1~10 s | 설계치 | FCU 유량계(없으면 열수지로 추정) |
| should | `coolant_pump_speed` | 냉각수 펌프 회전수(또는 지령) | rpm | 1~10 s | 설계치 | FCU |
| should | `coolant_conductivity` | 냉각수 전기전도도 | µS/cm | 1 min | < 5 µS/cm 권장(설계에 따라 교체기준 5~20) | 전도도계 → FCU |
| nice | `coolant_pump_power` | 냉각수 펌프 소비전력/전류 | W | 10 s | 설계치 | FCU |
| nice | `radiator_fan_speed` | 라디에이터 팬 회전수/지령 | % | 10 s | 0~100% | FCU |

### 전력변환·계통연계 `fc_power_conditioning`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `inverter_ac_power` | 인버터 AC 출력 전력 | kW | 1~10 s | 0~정격 | 인버터 Modbus |
| must | `grid_trip_event` | 계통연계 보호 트립 이벤트·원인 | enum | 이벤트(ms) | - | 인버터/보호계전기 이벤트 로그 |
| should | `inverter_dc_power` | 인버터 DC 입력 전력 | kW | 1~10 s | 0~정격 | 인버터 Modbus(SunSpec 호환 모델이면 model 103/113 유사) |
| should | `inverter_heatsink_temperature` | 인버터 방열판 온도 | °C | 10~60 s | 제조사 한계 이하 | 인버터 Modbus |
| should | `grid_voltage` | 계통 전압 | V | 1 s | 공칭 ±10% | 인버터/보호계전기 |
| should | `grid_frequency` | 계통 주파수 | Hz | 1 s | 60 ± 0.2 Hz | 인버터/보호계전기 |

### 열회수(CHP) 계통 `chp_heat_recovery`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| should | `hot_water_supply_temperature` | 열회수 온수 공급 온도 | °C | 10 s | PEMFC 50~70 °C(추정), PAFC 고온 120 °C/저온 60 °C | 열량계/PLC |
| should | `hot_water_return_temperature` | 열회수 온수 환수 온도 | °C | 10 s | 설계치 | 열량계/PLC |
| should | `hot_water_flow` | 열회수 온수 유량 | m³/h | 10 s | 설계치 | 열량계 |
| nice | `heat_output` | 회수 열출력 | kW | 1 min | 전기출력의 0.7~1.0배(추정) | 열량계(M-Bus/Modbus) |

### 연료전지 외함 환기 계통 `fc_enclosure_ventilation`

| 우선순위 | 메트릭 키 | 이름 | 단위 | 샘플 주기 | 전형 범위 | 흔한 출처 |
|---|---|---|---|---|---|---|
| must | `enclosure_h2_concentration` | 외함 내 수소 농도 | ppm | 1 s | 배경~경보 ≤ 10,000 ppm | 외함 검지기 → FCU/SIS |
| nice | `enclosure_temperature` | 외함 내부 온도 | °C | 1 min | 5~45 °C(추정) | FCU |

### 안전 인터록 (분석과 무관하게 즉시 알람)

- [설계원칙] 모든 안전 인터록은 현장 PLC/SIS(가스 수신반·화재수신반)에서 로컬로 실행한다. 콘솔은 원시 경보·ESD 이벤트를 분석 파이프라인(집계·이벤트추출·이상탐지)과 분리된 즉시 경로로 받아 최상위 우선순위로 표시·푸시·기록하며, 분석 결과(중복제거, 신뢰도, 억제 규칙)로 지연·억제·자동해제할 수 없다. 경보는 현장 수동 리셋 전까지 유지 표시.
- 수소 누출(ppm): KGS 가연성가스 검지경보장치 경보농도는 폭발하한계(수소 4 vol% = 40,000 ppm)의 1/4 이하 → 최대 1 vol%(10,000 ppm). 권장 2단: 1차 경보 예 0.4 vol%(4,000 ppm, 10% LEL) → 경보·환기 강화, 2차 1 vol%(10,000 ppm, 25% LEL) → ESD(차단밸브 폐쇄, 압축기·연료전지 정지). h2tools: 농도가 내려가도 수동 리셋까지 경보 유지. 실제 설정치는 인허가·설계값으로 대체.
- 연료전지 외함 내 수소 농도 경보치 도달 → 수소 공급 차단 + 스택 정지, 환기팬은 계속 운전(외함 내 농도를 폭발하한계 1/4 미만으로 유지하는 환기 설계).
- 연료전지 배기 수소 농도 과다 → 부하 감발/정지. 차량 참고치 UN GTR 13: 3초 이동평균 4 vol% 이하, 순간 8 vol% 이하(정치형은 제조사·KGS AH371 기준 확인).
- 과압: 저장뱅크·배관·압축기 단별 압력 ≥ 고압 트립 설정 → 압축기 정지·인입 차단밸브 폐쇄. 레귤레이터 하류 과압 → 긴급차단장치 작동. 안전밸브(PSV)·PRD 작동은 발생 즉시 무조건 경보 이벤트.
- 급감압·배관 파단 의심: 압력 강하율 > 설정치 또는 과류차단밸브 작동 → 계통 격리·ESD.
- 화염 감지(UV/IR; 수소 화염은 주간 비가시) → 즉시 ESD(전 차단밸브 폐쇄, 압축기·연료전지 정지, 전원 차단), 소화·살수 연동, 119/관리자 동시 통보.
- 압축기 다이어프램 파손(누설검지 포트 압력 스위치 작동) → 즉시 압축기 정지·흡입/토출 차단.
- 압축기 보호 트립: 단별 토출온도 고온(설정은 제조사; API 618 수소과다 서비스 설계 토출온도 한계 5판 135 °C, 6판 120 °C 참고), 윤활유/유압유 저압, 냉각수 유량 상실, 진동 트립(ISO 20816-8 zone D 수준), 모터 과부하.
- 저장용기 가스온도 > 85 °C(복합재 용기 일반 한계) 또는 < −40 °C → 충전 중지·인입 차단.
- 연료전지 셀 최저전압 차단(예: 0.3 V 이하 또는 음전압=셀 역전, 제조사 설정) → 부하 감발 또는 정지.
- 스택 과온·냉각수 유량 상실·냉각수 저수위 → 연료전지 정지.
- 절연저항 저하(지락) → 연료전지 전력변환 정지·DC 버스 분리.
- 환기팬 정지·풍량 스위치 이상 → 수소 공급 차단(환기 확인 전 기동 금지).
- 계통 이상(OVR/UVR/OFR/UFR, 단독운전 검출) → 인버터 계통 분리(한전 분산형전원 배전계통 연계 기술기준).
- 비상정지 버튼, 지진 감지, 화재수신반 연동 신호, 제어전원/UPS 이상 → ESD.
- 검지기·화염감지기 고장 또는 통신 두절(워치독) → 페일세이프: 해당 구역 경보 + 설정에 따라 수소 공급 차단. 콘솔에는 '안전감시 공백' 최고 우선 표시.

## 부록 A. 탐지 준비도 기준 필수·권장 포인트 (P3 구현 반영)

> 2026-09-16 갱신(주기 상한을 메트릭별로 나누고 권장 메트릭을 넣었다). 위 본문(리서치 추출 표)은 고치지 않았다.
> 이 부록은 구현된 탐지기 14종의 입력 요건(`requires`)을 코드에서 그대로 옮긴 것이다. 벤더·게이트웨이와 "어떤 포인트를 어떤 주기로 받을지" 협의할 때 본문의 must·should보다 먼저 본다.
> 메트릭 키는 콘솔 카탈로그 키다(`db/seed/catalog.ts`, 예: `poa.irradiance`). 본문 표의 키(예: `poa_irradiance`)와 이름이 달라서 A.3에 대응 관계를 적었다.
> 근거 코드: `lib/analytics/detectors/*.ts`(`requires`), `lib/analytics/readiness/`, `lib/analytics/pipeline/sources.ts`·`targets.ts`, `lib/analysis/aux-inputs.ts`, `lib/analytics/ledger/`. 판정 규칙 전체는 [설계 README §13.6](README.md)에 있다.

### A.1 판정 규칙 요약

- **셀:** 설비(행) × 탐지기(열)이다. 상태는 준비 / 부분 / 없음 / 해당 없음(n/a) 네 가지다.
- **필수 / 권장:** 메트릭은 두 가지다. **필수**는 없으면 탐지기가 돌지 않는다. **권장**은 없어도 판정하고 상태도 준비다 — 원인 판별 체크·조건 bin·보조 축만 줄어든다. 화면에서는 권장이 빠진 셀에 `*`를, CSV에서는 '누락 권장 메트릭' 열에 이름을 적는다.
- **없음:** 필수 메트릭 포인트가 하나라도 없다. (권장만 없으면 '없음'이 아니다.)
- **부분:** 필수 메트릭은 모두 있지만 아래 중 하나 이상에 걸린다.
  - 최근 30일 완결성이 0.9 미만이다(샘플이 없으면 0으로 본다).
  - 포인트 주기(`period_s`)가 **그 메트릭의** 주기 상한(`maxPeriodS`)보다 길다. 상한은 메트릭마다 다르다 — 그 메트릭이 판정에 기여하는 가장 빠른 현상의 시간상수로 정한다. 전기적 순시값(스택·랙 전압·전류, 셀 전압)은 60초, 적산·온도·압력·상태·누적 카운터는 300초다. 권장 메트릭의 주기는 보지 않는다.
  - 이력이 최소 이력보다 짧다. 요건 정의는 기준선 재설정 이후 기간이지만, 준비도 화면은 첫 샘플부터 센다.
- **여러 포인트:** 같은 메트릭 포인트가 여럿(한정자)이면 완결성 → 주기 → 이력 순으로 가장 좋은 포인트 하나로 판정한다. 한정자는 무시하고 메트릭 키만으로 맞춘다.
- **사이트 단위 탐지기(물질수지·오염):** 첫 행 '(사이트 전체)'에서, 요구 설비 종류에 해당하는 설비들의 포인트를 합쳐 판정한다.
- **설비 단위 탐지기:** 대상 설비 행에서, 자기 포인트와 분석이 합쳐 쓰는 상위·형제·사이트 설비 포인트로 판정한다. 아래 표의 "출처 설비"가 그 설비다.

### A.2 탐지기별 필수 메트릭·주기 상한·최소 이력

메트릭 뒤 숫자는 그 메트릭의 주기 상한(`maxPeriodS`, 초)이다. '권장' 열은 없어도 준비 상태가 되는 메트릭이다.

| 탐지기 | 고장모드 | 준비도 행 | 요구 설비 종류 (`assetClass`) | 필수 메트릭 ≤주기 상한 (출처 설비) | 권장 메트릭 ≤주기 상한 (출처 설비) | 최소 이력 (`minHistoryDays`) |
|---|---|---|---|---|---|---|
| `dq.gap_flatline` | `dq.data_gap_flatline` | 포인트가 있는 모든 설비 | (전체) | 없음 — 매핑된 모든 포인트가 대상 (결측·고착은 포인트 자기 `period_s`로 본다) | — | 1일 |
| `ess.capacity_fade` | `ess.capacity_fade` | `ess.rack` | `ess.rack` | `batt.current` 60, `batt.voltage` 60, `batt.soc` 60, `cell.voltage.max` 60, `cell.voltage.min` 60, `cell.temp.avg` 300 (랙) | — | 30일 |
| `ess.cell_imbalance` | `ess.cell_imbalance` | `ess.rack` | `ess.rack` | `batt.current` 60, `cell.voltage.max` 60, `cell.voltage.min` 60 (랙) | — | 60일 |
| `ess.resistance_growth` | `ess.resistance_growth` | `ess.rack` | `ess.rack` | `batt.current` 60, `batt.voltage` 60, `batt.soc` 300, `cell.temp.avg` 300 (랙) | — | 45일 |
| `pv.inverter_peer` | `pv.inverter_underperformance` | `pv.inverter` | `pv.inverter` | `ac.power` 300, `ac.power.limit` 300, `op.state` 300 (인버터) | — | 7일 |
| `inv.thermal_derating` | `pv.inverter_thermal_derating` | `pv.inverter` | `pv.inverter`, `wx.station` | `ac.power` 300, `heatsink.temp` 300, `ac.power.limit` 300 (인버터) · `ambient.temp` 300 (`wx.station`) | — | 30일 |
| `pv.soiling_rate` | `pv.soiling` | (사이트 전체) | `pv.plant`, `pv.inverter`, `wx.station` | `ac.power` 300, `ac.power.limit` 300, `op.state` 300 (`pv.inverter`) · `poa.irradiance` 300, `module.temp` 300 (`wx.station`) | `ghi.irradiance` 300 (`wx.station`) | 30일 |
| `el.voltage_rise` | `el.stack_voltage_degradation` | `h2.elz.stack` | `h2.elz.stack` | `stack.current` 60, `stack.voltage` 60, `stack.temp` 300, `run.hours` 300 (스택) | — | 30일 |
| `el.sec_rise` | `el.system_efficiency_loss` | `h2.elz.stack` | `h2.elz.stack` | `stack.current` 60, `stack.voltage` 60, `stack.temp` 300, `run.hours` 300 (스택) · `h2.flow.mass` 300, `ac.power` 300 (상위 `h2.elz`) | `rectifier.efficiency` 300 (형제 `h2.elz.rectifier`) · `purge.count` 300 (스택 또는 상위 `h2.elz`, **카탈로그에 없음**) | 45일 |
| `h2chain.mass_balance_gap` | `h2chain.mass_balance_gap` | (사이트 전체) | `h2.elz`, `h2.storage.tank`, `fc.plant` | `h2.flow.mass` 300 (`h2.elz`) · `fc.h2.consumption` 300 (`fc.plant`) · `tank.pressure` 300, `tank.temp` 300 (`h2.storage.tank`) | `h2.mass.total` 300 (`h2.elz`) · `purge.count` 300 (`fc.plant`) | 21일 |
| `tank.static_leak` | `h2.storage_leak` | `h2.storage.tank` | `h2.storage.tank` | `tank.pressure` 300, `tank.temp` 300 (용기) · `valve.open` 300 (상위 `h2.storage.bank`, 한정자 `inlet`·`outlet`) · `compressor.power` 300 (`h2.compressor`) · `fc.h2.consumption` 300 (`fc.plant`) | `h2.pressure` 300 (`fc.plant`, 하류 공급 압력) | 14일 |
| `comp.sec_rise` | `comp.efficiency_loss` | `h2.compressor` | `h2.compressor` | `compressor.power` 300, `compressor.suction.pressure` 300, `compressor.discharge.pressure` 300 (압축기) · `h2.flow.mass` 300 (`h2.elz`) · `ambient.temp` 300 (`wx.station`) | `compressor.discharge.temp` 300, `compressor.leak.pressure` 300, `vibration.rms` 300, `run.hours` 300 (압축기) | 45일 |
| `fc.voltage_decay` | `fc.stack_voltage_decay` | `fc.stack` | `fc.stack` | `stack.current` 60, `stack.voltage` 60, `stack.temp` 300, `run.hours` 300 (스택) | `blower.power` 300 (형제 `fc.blower`, 판별 체크 전용) | 30일 |
| `fc.blower_wear` | `fc.blower_wear` | `fc.blower` | `fc.blower` | `blower.power` 300, `blower.flow` 300 (블로워) · `ambient.temp` 300 (`wx.station`) · `run.hours` 300 (형제 `fc.stack`) | — | 45일 |

### A.3 필수 포인트 합계 (설비 종류별)와 본문 표 대응

필수 메트릭 키는 27개이고, 설비 종류와 묶으면 32개다. 주기 상한과 최소 이력은 그 포인트를 **필수로** 요구하는 탐지기 중 가장 엄격한 값이다(권장으로만 쓰는 탐지기는 세지 않는다).

| 설비 종류 | 메트릭 키 | 이름 · 정규 단위 | 요구 탐지기 | 주기 상한 | 최소 이력 | 본문 표 대응 키 (우선순위) |
|---|---|---|---|---|---|---|
| `ess.rack` | `batt.current` | 배터리 전류(충전 +) · A | `ess.capacity_fade`, `ess.cell_imbalance`, `ess.resistance_growth` | 60 s | 60일 | `battery_rack.rack_current` (must) |
| `ess.rack` | `batt.voltage` | 배터리 전압 · V | `ess.capacity_fade`, `ess.resistance_growth` | 60 s | 45일 | `battery_rack.rack_voltage` (must) |
| `ess.rack` | `batt.soc` | 충전상태(SOC) · % | `ess.capacity_fade`, `ess.resistance_growth` | 60 s | 45일 | `battery_bank.soc` (must) — 본문은 뱅크 단위, 탐지는 **랙 단위** 필요 |
| `ess.rack` | `cell.temp.avg` | 평균 셀 온도 · °C | `ess.capacity_fade`, `ess.resistance_growth` | 300 s | 45일 | `battery_rack.cell_temperature_avg` (must) |
| `ess.rack` | `cell.voltage.max` | 최고 셀 전압 · V | `ess.capacity_fade`, `ess.cell_imbalance` | 60 s | 60일 | `battery_rack.cell_voltage_max` (must) |
| `ess.rack` | `cell.voltage.min` | 최저 셀 전압 · V | `ess.capacity_fade`, `ess.cell_imbalance` | 60 s | 60일 | `battery_rack.cell_voltage_min` (must) |
| `pv.inverter` | `ac.power` | 교류 유효전력 · kW | `pv.inverter_peer`, `pv.soiling_rate`, `inv.thermal_derating` | 300 s | 30일 | `inverter.ac_active_power` (must) |
| `pv.inverter` | `ac.power.limit` | 출력 제한 설정값 · % | `pv.inverter_peer`, `pv.soiling_rate`, `inv.thermal_derating` | 300 s | 30일 | `inverter.active_power_limit_setpoint` (must) |
| `pv.inverter` | `op.state` | 운전 상태 코드 | `pv.inverter_peer`, `pv.soiling_rate` | 300 s | 30일 | `inverter.operating_state` (must) |
| `pv.inverter` | `heatsink.temp` | 방열판 온도 · °C | `inv.thermal_derating` | 300 s | 30일 | `inverter.heatsink_temperature` (must) |
| `wx.station` | `poa.irradiance` | 경사면 일사량(POA) · W/m² | `pv.soiling_rate` | 300 s | 30일 | `weather_station.poa_irradiance` (must) |
| `wx.station` | `module.temp` | 모듈 후면 온도 · °C | `pv.soiling_rate` | 300 s | 30일 | `weather_station.module_temperature` (must) |
| `wx.station` | `ambient.temp` | 외기 온도 · °C | `comp.sec_rise`, `fc.blower_wear`, `inv.thermal_derating` | 300 s | 45일 | `weather_station.ambient_temperature` (must) |
| `h2.elz` | `h2.flow.mass` | 수소 질량유량 · kg/h | `el.sec_rise`, `h2chain.mass_balance_gap`, `comp.sec_rise` | 300 s | 45일 | `electrolyzer_system.h2_mass_flow` (must) |
| `h2.elz` | `ac.power` | 교류 유효전력(설비 전체, BoP 포함) · kW | `el.sec_rise` | 300 s | 45일 | `electrolyzer_system.ac_power_total` (must) |
| `h2.elz.stack` | `stack.current` | 스택 전류 · A | `el.voltage_rise`, `el.sec_rise` | 60 s | 45일 | `electrolyzer_stack.stack_current` (must) |
| `h2.elz.stack` | `stack.voltage` | 스택 전압 · V | `el.voltage_rise`, `el.sec_rise` | 60 s | 45일 | `electrolyzer_stack.stack_voltage` (must) |
| `h2.elz.stack` | `stack.temp` | 스택 온도(출구) · °C | `el.voltage_rise`, `el.sec_rise` | 300 s | 45일 | `electrolyzer_stack.stack_temp_outlet` (must) |
| `h2.elz.stack` | `run.hours` | 누적 운전시간 · h | `el.voltage_rise`, `el.sec_rise` | 300 s | 45일 | `electrolyzer_stack.stack_run_hours` (must) |
| `h2.compressor` | `compressor.power` | 압축기 소비전력 · kW | `tank.static_leak`, `comp.sec_rise` | 300 s | 45일 | `h2_compressor.motor_power` (must) |
| `h2.compressor` | `compressor.suction.pressure` | 압축기 흡입 압력 · bar | `comp.sec_rise` | 300 s | 45일 | `h2_compressor.suction_pressure` (must) |
| `h2.compressor` | `compressor.discharge.pressure` | 압축기 최종 토출 압력 · bar | `comp.sec_rise` | 300 s | 45일 | `h2_compressor.discharge_pressure` (must) |
| `h2.storage.bank` | `valve.open` (한정자 `inlet`·`outlet`) | 차단밸브 열림 · bool | `tank.static_leak` | 300 s | 14일 | `h2_storage_bank.inlet_valve_state`·`outlet_valve_state` (must) |
| `h2.storage.tank` | `tank.pressure` | 저장용기 압력 · bar (절대압으로 봄) | `h2chain.mass_balance_gap`, `tank.static_leak` | 300 s | 21일 | `h2_storage_bank.tank_pressure` (must) — 본문은 용기군 단위, 탐지는 **용기별** 필요 |
| `h2.storage.tank` | `tank.temp` | 저장용기 온도 · °C | `h2chain.mass_balance_gap`, `tank.static_leak` | 300 s | 21일 | `h2_storage_bank.tank_wall_temperature` (must) 또는 `tank_gas_temperature` (should) |
| `fc.plant` | `fc.h2.consumption` | 연료전지 수소 소비 유량 · kg/h | `h2chain.mass_balance_gap`, `tank.static_leak` | 300 s | 21일 | `h2_valve_train.h2_supply_flow` (must) |
| `fc.stack` | `stack.current` | 스택 전류 · A | `fc.voltage_decay` | 60 s | 30일 | `fc_stack.stack_current` (must) |
| `fc.stack` | `stack.voltage` | 스택 전압 · V | `fc.voltage_decay` | 60 s | 30일 | `fc_stack.stack_voltage` (must) |
| `fc.stack` | `stack.temp` | 스택 온도(출구) · °C | `fc.voltage_decay` | 300 s | 30일 | `fc_stack.stack_temperature` (must) |
| `fc.stack` | `run.hours` | 누적 운전시간 · h | `fc.voltage_decay`, `fc.blower_wear` | 300 s | 45일 | **본문 연료전지 표에 없음** |
| `fc.blower` | `blower.power` | 공기 블로워 소비전력 · kW | `fc.blower_wear`(필수), `fc.voltage_decay`(권장) | 300 s | 45일 | `fc_cathode_subsystem.blower_power` (**should** — `fc.blower_wear`의 필수) |
| `fc.blower` | `blower.flow` | 공기 질량유량 · kg/h | `fc.blower_wear` | 300 s | 45일 | `fc_cathode_subsystem.air_mass_flow` (must) |

### A.4 권장 포인트 (필수는 아니지만 분석이 읽는 것)

상태(준비/부분/없음)를 바꾸지는 않는다. 다만 A.2의 '권장 메트릭' 열에 있는 것은 준비도 매트릭스가 빠진 것을 `*`와 CSV '누락 권장 메트릭' 열로 보여 준다 — 벤더 협의에서 "없어도 되지만 확보하면 원인 판별이 는다"로 쓴다. 나머지(체인 원장 흐름·기동 횟수·이벤트 로그·SMP·정비 이력)는 준비도에 나오지 않는다. 없으면 아래처럼 판별 체크가 '데이터없음'이 되거나 다른 방식으로 대체된다.

| 설비 종류 | 메트릭 키 · 입력 | 쓰는 곳 | 없을 때 | 본문 표 대응 |
|---|---|---|---|---|
| `h2.elz` | `h2.mass.total` (누적 수소 생산량, kg) | 체인 원장 생산량 1순위(적산계 하루 증가량) | `h2.flow.mass` 시간 평균 적산으로 대체. 시뮬레이터 건강 사이트 일 잔차율 p95 2.083% → 적산계 사용 0.297% | `electrolyzer_system.h2_total_produced` (must) |
| `h2.elz` | `start.count` | 전해조 기동 에피소드(`el.start`) 기동 횟수 증가량 | 해당 특징값이 비어 있음 | `electrolyzer_system.start_count` (should) |
| `h2.elz.rectifier` | `rectifier.efficiency` (%) | `el.sec_rise` 판별 체크 ② 정류기 효율 저하(1시간 롤업 → 일 중앙값) | 체크 '데이터없음' | 본문에 없음 (`rectifier.rectifier_ac_power`·`rectifier_dc_power`로 산출 가능) |
| `h2.elz.rectifier` | `ac.power` (kW) | 체인 원장 전해조 흐름(정류기 AC 입력) | 전해조 설비 전체 `ac.power`로 대체 | `rectifier.rectifier_ac_power` (must) |
| `ess.pcs` | `ac.power` (kW, 방전 +, 충전 −) | 체인 원장 ESS 충방전 흐름 | 원장 흐름에서 빠짐 | `ess_pcs.pcs_ac_active_power` (must) |
| `grid.meter` | `ac.power` (kW, 송전 +, 수전 −) | 체인 원장 계통 수전·송전, 전해조 계통전력 비율 | 원장 흐름에서 빠짐 | 본문은 15분 적산량(`grid_interconnection.export_energy` must, `aux_import_energy` should)만 있고 순시 전력 행 없음 |
| `fc.plant` | `fc.ac.power` (kW) | 체인 원장 연료전지 공급·kg/MWh·P2P, 연료전지 정상운전 에피소드 | 연료전지 KPI 없음 | `fuel_cell_system.net_ac_power` (must) |
| `fc.plant` | `purge.count` (누적) | 체인 원장 배출 추정(`kgPerPurge` > 0일 때만), 물질수지 판별 체크 ③ | 배출 추정 0, 체크 '데이터없음' | `fc_anode_subsystem.purge_valve_state` (should, 이벤트) |
| `fc.plant` | `h2.pressure` (bar, 연료전지 공급 압력) | `tank.static_leak` 판별 체크 ③ 밸브 통과 누설(하류 압력 상승) | 체크 '데이터없음' | `fuel_cell_system.h2_inlet_pressure` (must) |
| `fc.plant` | `start.count` | 연료전지 기동 에피소드(`fc.start`) 기동 횟수 증가량 | 해당 특징값이 비어 있음 | `fuel_cell_system.start_count` (must) |
| `h2.compressor` | `compressor.discharge.temp` (°C) | `comp.sec_rise` 판별 체크 ① 토출 온도 상승 | 체크 '데이터없음' | `h2_compressor.discharge_temperature` (must) |
| `h2.compressor` | `compressor.leak.pressure` (bar) | `comp.sec_rise` 판별 체크 ② 누설 감지 압력 상승 (safety finding은 내지 않음) | 체크 '데이터없음' | `h2_compressor.diaphragm_leak_detect_pressure` (must) |
| `h2.compressor` | `vibration.rms` (mm/s) | `comp.sec_rise` 판별 체크 ③ 진동 증가 | 체크 '데이터없음' | `h2_compressor.vibration_velocity_rms` (should) |
| `h2.compressor` | `run.hours` (h) | `comp.sec_rise` 누적 운전시간 축 추세 | 추세를 계산하지 못함(같은 조건 비교는 동작) | `h2_compressor.operating_hours` (must) |
| `h2.storage.bank` | `h2.inventory` (kg) | `comp.run` 이송 질량 대체값(전해조 유량이 없을 때, 운전 중 인출이 섞이면 과소) | 전해조 유량이 없으면 이송 질량 없음 | 본문에 없음 (PLC 재고 추정) |
| `wx.station` | `ghi.irradiance` (W/m²) | `pv.soiling_rate` 판별 체크 ② 일사계 오염·드리프트(GHI/POA 비율) | 체크 '데이터없음' | `weather_station.ghi_irradiance` (should) |
| `ess.rack` | `batt.soc` 시간 최대 | PV 미활용 분해 `ess_full` 버킷(SOC ≥ 90%) | 해당 버킷 판정 불가 | (A.3 필수와 같은 포인트) |
| `om.event_log` | 인버터 이벤트 코드 | `inv.thermal_derating` 판별 체크 ② 냉각팬 고장 코드 | 체크 '데이터없음' | `inverter.operating_state` (must, 고장 코드) |
| `om.market_daily` | `smp_land` | `pv.soiling_rate` 권고 문장의 손실 금액 | "가격 데이터 없음" | 본문 밖 (수기·CSV 입력) |
| 조치·설비 이벤트 | 세척 조치, `asset_event`(필터 교체·세척 note) | `pv.soiling_rate` 복원 시점, `fc.blower_wear` 판별 체크 ① 필터 막힘 | 복원은 PI 급상승으로만, 필터 체크 '데이터없음' | 본문 밖 (정비 이력 직접 기록·CSV) |

2026-09-16 기준으로 퍼지 횟수(`el.sec_rise`)와 같은 뱅크 다른 용기 압력 교차값(`tank.static_leak`)은 분석 실행기가 넣는다. 다만 전해조 퍼지 카운터(`purge.count`)는 카탈로그에 없어 전해조 퍼지 체크는 여전히 '데이터없음'이고, 준비도에서는 ELZ1/STACK1의 권장 메트릭 누락으로 보인다. 시드 사이트에서 일부러 매핑하지 않은 압축기 진동(`vibration.rms`)도 같은 방식으로 COMP1에 권장 누락으로 보인다.

### A.5 탐지에 쓰는 명판 값

| 설비 종류 | 명판 필드 | 쓰는 곳 |
|---|---|---|
| `ess.rack` | `capacity_ah`, `energy_kwh` | 충방전·전류 계단 에피소드(C-rate), ESS KPI |
| `pv.inverter` | `dc_kwp`, `ac_kw`, `derate_start_c` | 일 발전 에피소드·동종 비교·PV 미활용 분해, 열 저감 시작 온도(없으면 70 °C) |
| `pv.plant` | `gamma_per_c` | 오염 온도 보정(없으면 −0.0035 /°C) |
| `h2.elz.stack`, `fc.stack` | `cell_count`, `active_area_cm2`, `rated_current_a` | 셀 전압·전류밀도, 패러데이 이론 생산량 |
| `h2.compressor`, `fc.blower` | `rated_kw` | 운전 구간 판정 |
| `h2.storage.tank` | `water_volume_l` | 용기 질량(누설 탐지·원장 저장량 변화) |

### A.6 본문 표와 다른 점 (협의 때 확인)

- **연료전지 스택 누적 운전시간:** `run.hours`는 `fc.voltage_decay`·`fc.blower_wear`의 필수 메트릭인데 본문 연료전지 표에 없다.
- **블로워 전력:** 본문은 should이지만 탐지기 2종에서 필수다.
- **SOC 단위:** 본문은 뱅크 SOC만 있다. 용량·내부저항 탐지는 랙 SOC가 필요하다.
- **저장용기 압력·온도:** 본문은 저장뱅크(용기군) 단위다. 누설 탐지는 용기별 포인트와 용기 내용적 명판이 필요하다. 압력은 절대압으로 보므로, 게이지압이면 매핑 `offset`으로 바꾼다.
- **차단밸브:** `valve.open`은 한정자 `inlet`·`outlet`로 매핑해야 정지 보유 추출에 들어간다. 준비도는 메트릭 키만 보므로 둘 중 하나만 있어도 '준비'로 보일 수 있다. 추출기는 유입 쪽(입구 밸브·압축기 전력·전해조 유량)과 유출 쪽(출구 밸브·연료전지 소비) 신호가 하나씩은 있어야 정지로 확정한다.
- **샘플 주기:** 본문 권장 주기(ESS DCIR용 2초 이하, 스택 1초 등)보다 탐지기 상한(60초·300초)이 느슨하다. 내부저항 R_step = ΔV/ΔI는 샘플 주기에 따라 값이 달라져 같은 주기끼리만 비교하므로, 랙 전류·전압 주기는 정한 뒤 바꾸지 않는다.
- **카탈로그에 없는 메트릭:**
  - 일 강수량(본문 should `rainfall_daily`): 오염 복원은 맑은 날 PI 1.5% 급상승으로 대신한다.
  - 압축기 흡입 가스 온도(본문 should `suction_temperature`): 외기 온도로 대신한다.
- **계량점 위치:** 체인 원장 기본값은 수소 유량계가 건조기 뒤(제품)에 있고(`dryerLossFraction` 0), 연료전지 소비 계량이 퍼지를 포함하는 공급 측에 있다고(`kgPerPurge` 0) 본다. 위치가 다르면 원장 파라미터를 바꾼다.
- **시뮬레이터 시드 참고(SIM-B):** 스택 전압·전류는 60초지만 스택 온도·운전시간, 전해조 유량·AC 전력, 블로워 전력은 300초다. 그래서 주기 상한 60초인 스택 탐지기 셀이 '부분'으로 나온다. 현장 계약에서는 이 포인트들을 60초 이하로 받거나, 주기 상한을 메트릭별로 나누는 규칙 변경을 먼저 정한다.


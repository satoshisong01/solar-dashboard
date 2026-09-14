# HySol Desk — 태양광·수소 O&M 콘솔 리뉴얼 설계

- 작성일: 2026-09-14
- 상태: **확정 — P0~P3 구현 진행** (브랜치 `renewal/om-console`, 단계별 커밋)
- 제품명: **HySol Desk** (하이솔 데스크)
- 근거: 리서치 5건(자산 47종 · 텔레메트리 224개 · 파생지표 92개 · 고장모드 90개 · 출처 204건), 독립 설계안 3건 → 종합

| 문서 | 내용 |
|---|---|
| 이 문서 | 최종 설계 (구현 기준) |
| [hysol-desk-renewal-proposal.html](hysol-desk-renewal-proposal.html) · [.pdf](hysol-desk-renewal-proposal.pdf) | 검토용 제안서 (시각 요약본) |
| [data-contract-draft.md](data-contract-draft.md) | 설비별 수집 메트릭 초안 (must 106 · should 89 · nice 29) |
| [research/](research/) | 도메인·아키텍처·기술스택 리서치 원본 (JSON/MD, 출처 URL 포함) |
| [concepts/](concepts/) | 종합 전 독립 설계안 3건 (분석가 업무 흐름 / 데이터 플랫폼 / 실용 MVP) |

---

## 0. 확정 결정 — 2026-09-14 사전 질의 (본문과 충돌하면 이 절이 우선)

| 항목 | 확정 내용 | 본문에서 바뀌는 곳 |
|---|---|---|
| 구현 범위 | **P0~P3 전부** 연속 진행. P4는 "연결된 DB에 저장" 구조만 보장(`DATABASE_URL`을 RDS로 바꾸고 `db:migrate` 하면 동작). RDS 데이터 이관·Vercel 배포 작업은 하지 않음. P5 LLM 보류 | §8 |
| 로컬 DB | embedded-postgres (Docker 금지 — 개발 PC 블루스크린) | §6 |
| 원시 보존 | **영구 보관**. 원시 파티션 DROP/보존 잡 없음. 월 파티션 사전 생성만. 용량이 커지면 추후 아카이브 검토 | §5.2 |
| 분석 실행 | **수동 실행만**. 관리자가 사이트·설비·기간을 골라 "분석 실행" → 결과는 발견사항(finding)으로만 저장. 자동 분석·주간 크론 없음 → Vercel 크론 불필요 | §5.3 파이프라인의 tick/daily 크론 |
| 롤업 | 크론 대신 수집 직후 `after()`에서 dirty 시간 버킷을 처리하고, 분석 실행 시작 시 남은 dirty를 먼저 처리 | §5.3 |
| 리포트 | **분석과 출력 분리.** 분석이 리포트·파일을 자동으로 만들지 않음. 관리자가 "리포트 만들기" 버튼으로 초안 생성 → 검토 → "PDF 출력" 버튼. **메일 발송 기능 없음**, 전달은 사용자가 별도로 | §4 코칭 리포트 행, §5.3 월요일 리포트 |
| 로그인 | 이메일+비밀번호(가입 비활성, 운영자가 계정 발급) | — |
| 수익 위젯 | SMP·REC 수기 입력 + CSV 업로드 | §4 오늘 |
| 정비 이력 | 콘솔에서 직접 기록 + CSV 가져오기 | §4 조치 추적 |
| 수소 사양 기준 | PEM 전해조 + PEM 연료전지(순수소). 실제 사양이 오면 파라미터만 교체 | §5.5 |
| 사이트 | 실제 운영 중인 태양광·수소 사이트 없음, 기존 데이터는 전부 목데이터 → **가상 사이트 3곳**(SIM-A 태양광+ESS / SIM-B 연계형 / SIM-C 고장 없는 대조군). 기존 `solar_*` 테이블은 이관하지 않음 | §5.5, §11 |
| 연구 문서 | 별도 산출물(실데이터가 없으므로 업계 자료 기반 **예상안**): 태양광·수소발전에서 보통 받는 데이터, 그 데이터로 보는 수명·노후·개선 여지, 월 1회·분기 1회 AI 분석 시 탐지 가능한 항목과 분석 리포트 예시. **PPT 약 15장 + 엑셀(데이터 목록·수명·분석 주기 매트릭스) + Word 약 20쪽** | — |

## 1. 전제 (사용자 결정)

| 항목 | 결정 |
|---|---|
| 목적 | 관리자 전용 O&M 인텔리전스 콘솔. 사이트·설비·부품 원시데이터 → 분석 → 사이트별 유지보수 코칭 리포트. 최종 사용자용 아님 |
| 수소 형태 | 연계형: 태양광 → 수전해 → 수소 압축·저장 → 연료전지 발전 (ESS 포함 가능) |
| 인프라 | 로컬 PostgreSQL(embedded-postgres, Docker 미사용)로 개발 → 같은 마이그레이션을 기존 AWS RDS에 적용. 배포 Vercel 유지. Docker는 개발 PC에서 블루스크린을 일으켜 제외(2026-09-14) |
| AI | 이번 단계 LLM 미사용. 통계·규칙 기반 분석 + 리포트 템플릿. LLM은 교체 가능한 인터페이스만 |
| 기존 UI | 전면 재구성. 수익(SMP/REC)은 요약 위젯으로 축소 |
| 브랜딩 | "Solar" 중심 명칭 전면 교체 (화면·API 경로·DB 스키마). 제품명 HySol Desk. 저장소·폴더명 `solar-dashboard`는 P4까지 유지 |
| 인증 | 관리자 로그인 포함 |
| 데이터 계약 | 미정 → 스키마 변경 없이 메트릭을 추가할 수 있어야 함 |

## 2. 현재 구조에서 반드시 버려야 할 것

1. **브라우저가 데이터를 만든다** — `app/page.tsx`의 `setInterval`이 탭이 열려 있을 때만 가짜 IoT 데이터를 POST. 탭 여러 개면 중복, 안 열면 결측, 밤에도 발전.
2. **원시데이터를 매일 지운다** — `vercel.json` 크론이 24시간 지난 `solar_logs` 삭제. "과거 대비 변화" 분석과 정면 충돌.
3. **분석이 하드코딩** — 고장유형 `[12,5,8,3,2]`, `SMP=160`, 설치일 `2023-01-15`, "▲2.1%", 날짜 `2026-01-06` 등.
4. **태양광 전용 평면 스키마** — 설비·부품 계층 없음. `solar_logs`에 차트 배열·AI 메시지까지 섞여 있음.
5. **보안** — 인증 없음, 인증 없는 쓰기 API, RDS TLS 검증 끔(`rejectUnauthorized:false`), 지도 `innerHTML`에 사이트명 삽입(XSS), `weather-history` 커넥션 누수, 날씨 API 실패 시 가짜 값 반환(분석 데이터 오염), **Next 16.1.1 critical 취약점**(npm audit 확인, 16.3.5에서 해결).

재사용: `next.config.ts`·`tsconfig`·eslint/postcss 설정, LATERAL 최신값 쿼리 패턴, 날씨 상태→아이콘 매핑, 상태 색상 규칙, SMP/REC 카드 UI 아이디어, Kakao 지도 키.

## 3. 핵심 콘셉트

> **원시데이터 원장 위에서 "그때와 지금을 같은 조건으로 비교"하고, 그 결과를 코칭 → 조치 → 효과 검증까지 닫는 콘솔.**

세 기둥과 두 보조 원칙:

1. **계약 없이 받는 수집 원장** — 모든 입력은 하나의 서명된 봉투(`om.ingest.v1`)로 들어온다. 원본은 bronze에 보존하고, 모르는 태그도 거부하지 않고 "미매핑 인박스"에 쌓는다. 나중에 매핑하면 원본을 재처리(replay)해 과거까지 채운다.
2. **같은 조건 비교 엔진** — 원시 시계열을 운전 에피소드(충전 세션, 정상운전 구간 등)로 자르고, 조건(전류·온도·부하 bin)이 같은 과거 기준선과 비교해 효과 크기 + 95% 신뢰구간으로 판정한다. 모든 설비에 같은 일반형을 적용한다.
3. **코칭 폐루프** — 발견사항(finding) → 분석 데스크에서 근거 확인·원인 판별 → 코칭 리포트 → 현장 조치 기록 → 조치 전후를 같은 조건으로 비교해 효과 검증.
- **사이트 에너지·수소 체인 원장** — PV → ESS/전해조 → H₂ kg → 저장 → 연료전지 kWh를 일 단위로 닫고 물질수지 잔차를 감시한다 (연계형 특화).
- **안전 레인 분리** — 수소 누출·ESD·화재·셀 한계 같은 안전 이벤트는 분석 파이프라인을 거치지 않고 즉시 고정 표시. 콘솔은 인터록을 대체하지 않으며, 통신 두절 시 "안전 데이터 불확실"을 표시한다.

### 3.1 사용자 예시가 파이프라인을 통과하는 과정

"같은 전압·전류에서 0→100% 충전이 8시간 → 7시간 30분" (50 A 충전 가정, 표본 수·CI는 예시 수치)

| 단계 | 처리 | 산출 |
|---|---|---|
| 원시 | 게이트웨이가 랙별 `dc.current`, `dc.voltage`, `batt.soc`, `cell.voltage.max/min/avg`, `cell.temp.avg/max`를 10~60초 주기, 5분 배치로 전송. 셀 수백 개 원시값 대신 게이트웨이에서 통계로 축약 | `om.measurement` |
| 에피소드 | 전류 > +0.02C가 2분 이상 → 충전 시작, \|I\| ≤ 0.02C 5분 → 종료. 시작 전 60분 휴지 여부·CV 종료 도달 태깅 | `ess.charge` 에피소드 |
| 특징 | `ah_in`, `wh_in`, `i_mean_c`, `t_cell_mean`, `soc_ocv_start`, `cc_ah`, `cv_s`, `duration_s`. 유효 앵커 세션(휴지 후 시작 SOC ≤ 20%, CV 종료, 데이터 완결성 ≥ 95%)은 `capacity_ah = ah_in / (1 − soc_start)` | `episode.features` |
| 조건 비교 | 기준 창(준공 후 30~120일, 첫 유효 20세션) vs 최근 30일을 C-rate 0.05C × 셀온도 5 °C bin으로 매칭 → bin별 중앙값 비율 표본가중 결합 + 부트스트랩 95% CI. bin당 5개·전체 15개 미만이면 `insufficient` | 400 Ah → 375 Ah, **−6.25%** (CI −4.9 ~ −7.9%) |
| 판별 | CC 구간 Ah 감소 + CV 시간 증가 여부로 "용량 감소 vs 내부저항 증가" 구분, SOC 상한 설정 변경·저온·BMS 재보정 여부 확인 | 원인 후보 순위 |
| finding | `ess.capacity_fade@1`, severity 3, confidence 0.8, dedup_key로 매일 중복 생성 방지, 근거 스냅샷 append | `om.finding` |
| 리포트 | "같은 조건 충전 18회 비교: 유효용량 400 Ah → 375 Ah(−6.3%), 50 A 기준 충전시간 약 8h 0m → 7h 30m. SOH 80% 도달 추정 …" + 권고 조치 + 인용 | 코칭 리포트 |
| 조치·검증 | "셀 밸런싱 + 기준 조건 용량시험" 기록 → 안정화 7일 후 전후 30일을 같은 bin으로 비교 → `improved / no_change / worse / insufficient` | `om.action_verification` |

판정은 시간이 아니라 **Ah(유효용량)** 로 하고, 현장이 이해하기 쉽게 **기준 전류 환산 시간**을 병기한다. 시간 지표는 전류·시작 SOC 차이와 BMS SOC 재보정에 민감하기 때문이다.

## 4. 화면 구성 (IA)

라우트 그룹: `app/(auth)/login`, `app/(console)/…`. 루트 레이아웃은 하나.

| 메뉴 | 라우트 | 목적 | 핵심 위젯 | 단계 |
|---|---|---|---|---|
| 오늘 | `/` | 출근 후 5분 안에 할 일과 밤사이 변화 파악 | 안전 배너(ack 전 고정) · 할 일 카운터(새 finding / 조사 중 / 리포트 승인 대기 / 검증 결과 도착) · 신규·악화 finding Top 10 · 데이터 공백(끊긴 게이트웨이, 미매핑 태그) · 수익 요약 위젯 | P1 골격, P2 완성 |
| 플릿 | `/fleet` | 여러 사이트를 도메인별 건강 상태로 관망 | 사이트 × 도메인(PV / ESS / 전해조 / 저장 / 연료전지 / 데이터품질) 히트 매트릭스 · Kakao 지도 토글(상태·날씨 마커) | P1 |
| 사이트 | `/sites/[siteCode]` | 사이트 맥락: 설비 트리, KPI, 타임라인, 에너지·수소 체인 | 자산 트리 + finding 배지 · KPI 카드(PR, ESS 왕복효율, 전해조 kWh/kg, 연료전지 kg/MWh, 가용률) · 이벤트 타임라인 · 체인 Sankey + 물질수지 잔차(P3) | P1, P3 |
| 자산 상세 | `/sites/[siteCode]/assets/[assetId]` | 부품 단위 원시·롤업 시계열과 같은 조건 비교 | ECharts 다중축 시계열 + 에피소드/출력제어/DQ 밴드 · 에피소드 표 · 같은 조건 비교 카드 · 명판·포인트 매핑 · finding·조치 이력 | P1, P2 |
| 탐색기 | `/explore` | 임의 포인트를 골라 원시 데이터 탐색 | 자산 트리 + 메트릭 피커 · 줌 시 서버 재조회(date_bin min/avg/max) · 저장된 뷰 | P1 |
| 분석 데스크 | `/desk`, `/desk/[findingId]` | finding 분류와 근거 확인·원인 판별·권고 작성 | 인박스(심각도×신뢰도 정렬, 필터, 일괄 분류, 기각 사유 필수) · 증거 캔버스(같은 조건 비교표 · **에피소드 오버레이** · Theil–Sen 추세 + CUSUM 변화시점 · 원시 시계열 · 동종 비교) · 원인 후보 판별 체크 · 권고 조치 작성 · 탐지기 신뢰 배지 | P2 |
| 코칭 리포트 | `/reports`, `/reports/[id]`, `/reports/[id]/print` | 사이트별 주간·긴급 리포트 초안 검토·승인·전달 | 이번 주 할 일 3개 · 발견사항 · 데이터 품질 요청 · 검증된 조치 효과 · KPI · 인용 칩 · 검증기 결과 · 인쇄용 HTML · 전달 기록 | P2 |
| 조치 추적 | `/actions` | 권고가 조치와 효과 검증으로 이어지는지 추적 | 조치 목록(연결 finding) · 검증 대기 큐 · 전후 비교 차트 · 코칭 성과(수용률, 효과 확인률, 재발률) | P2 |
| 안전 | `/safety` | 안전 이벤트 즉시 경로와 확인 이력 | 미확인 안전 이벤트(자동 해제 불가) · 안전감시 공백 타임라인 · ack 기록 | P1 |
| 데이터 | `/data`, `/data/unmapped`, `/data/quality`, `/data/readiness` | 수집 상태·데이터 품질 관리, 데이터 계약 협의 지원 | 게이트웨이 표(last seen, 시계 오차, 배치 공백) · 미매핑 태그 → 매핑 → 재처리 · DQ 이슈 · **탐지 준비도 매트릭스**(P3) | P1, P3 |
| 설정 | `/settings/{catalog,detectors,gateways,admins}` | 스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자 | 자산 트리 편집 · metric_def 편집 · 탐지기 설정 버전 · 게이트웨이 키(활성 2개 회전) · 관리자 계정 | P1, P2 |
| 시뮬레이터 | `/sim` (개발 플래그) | 주입 고장 대비 엔진 성능 | 탐지기별 재현율·정밀도·오탐·탐지 지연·최소 탐지 크기 곡선 | P2 |

### 4.1 채택한 차별화 아이디어

- **"그때 vs 지금, 같은 조건" 비교 카드** — 모든 열화 finding에 bin별 n · 중앙값 · 비율 · 95% CI.
- **에피소드 오버레이** — 기준기간 대표 충전과 최근 충전의 원시 곡선을 t=0 정렬로 겹치고 x축을 경과시간 / 누적 Ah / SOC로 전환. "8시간 → 7시간 30분"을 원시 데이터 그대로 보여 준다.
- **기각이 곧 학습** — 기각 사유 "운영 조건 변경"을 고르면 `asset_event(resets_baseline)`가 생기고 기준선이 그 시점에서 분할되어 같은 오탐이 사라진다. 부품 교체·펌웨어·설정값 변경도 같은 경로.
- **탐지기 신뢰 배지** — 시뮬레이터 스코어카드(최소 탐지 크기, 재현율, 오탐률)를 finding 옆에 표시.
- **계약 없는 수집 인박스 + 재처리** — 협의가 끝나기 전에 수집을 시작할 수 있다.
- **탐지 준비도 매트릭스** — 자산 × 고장모드마다 필요한 메트릭 충족 여부, "이 메트릭을 확보하면 풀리는 고장모드 수" 순위. 벤더와 데이터 계약 협상 자료.
- **Planner / Composer 분리** — 무엇을 말할지(항목·수치·우선순위)는 결정적 엔진이, 어떻게 말할지만 교체 가능. LLM이 들어와도 수치와 판정은 못 바꾼다.
- **조치 효과 자동 검증** — 코칭이 실제로 효과가 있었는지 수치로 닫는다. 재발은 `previous_finding_id`로 연결.
- **데이터 품질도 코칭 항목** — 고착 센서·시계 오차·통신 공백을 finding으로 올려 센서 교정·통신 개선을 권고. PV 저성능 경보는 센서 건전성 통과 시에만 발행.
- **운전시간 축 열화 추적** — 전해조·연료전지는 달력이 아니라 누적 운전시간 기준 µV/h 기울기, 기동·정지 1회당 손실로 운전 패턴을 코칭.

### 4.2 의도적으로 미룬 것

케이스(여러 finding 묶음) 레이어, 키보드 중심 트리아지, 탐지기 섀도 릴리스, 재처리 dry-run diff 화면, finding 재현 실행 버튼(단 `detector_id@version`·`input_hash`는 P2부터 기록), 포인트 매핑 시간 이력, 발전소용 공유 링크·회신 폼, 서버 PDF·이메일 발송, LLM. 모두 P2 이후 사용 경험을 보고 판단한다.

## 5. 데이터 아키텍처

### 5.1 수집 봉투 `om.ingest.v1`

```http
POST /api/ingest/v1
Content-Encoding: gzip
X-OM-Key-Id: gk_sim-b_2026q3
X-OM-Timestamp: 1757819100
X-OM-Signature: v1=hex(HMAC_SHA256(secret, keyId + "." + ts + "." + sha256hex(body)))
```

```json
{
  "schema": "om.ingest.v1",
  "gateway": "GW-SIMB-A",
  "batch_id": "01923f6e-7c1a-7b1e-9a4e-2f1c3d5e7a90",
  "seq": 182340,
  "sent_at": "2026-09-14T03:05:00.120Z",
  "clock": { "ntp_synced": true, "ntp_offset_ms": -12 },
  "series": [
    { "src": "ESS1/RACK03/I_DC", "unit": "A", "t0": 1757818800000, "dt": 10000, "v": [55.1, 55.3, null, 54.9], "q": [0, 0, 1, 0] },
    { "src": "ESS1/RACK03/SOC", "unit": "%", "ts": [1757818805000, 1757818866000], "v": [41.2, 41.6] },
    { "src": "ELZ1/STACK1/V", "unit": "V", "t0": 1757818800000, "dt": 10000, "v": [412.1, 412.3, 412.0] },
    { "src": "ELZ1/H2_FLOW", "unit": "kg/h", "t0": 1757818800000, "dt": 60000, "v": [9.81, 9.84] },
    { "src": "H2BANK1/P", "unit": "bar", "t0": 1757818800000, "dt": 10000, "v": [312.4, 312.4, 312.5] }
  ],
  "events": [
    { "src": "PCS1/FAULT", "ts": 1757818930000, "code": "E023", "severity": "major", "text": "DC overvoltage" },
    { "src": "H2BANK1/GAS_DET2", "ts": 1757818990000, "code": "H2_ALARM_L1", "severity": "critical" }
  ]
}
```

규칙:
1. **인증** — 게이트웨이별 HMAC-SHA256, 시각 허용 ±300초, `timingSafeEqual`. 순서: 서명 검증 → 압축 해제(상한 20 MB) → zod.
2. **크기** — 기본 5분 flush, 압축 후 1 MB·샘플 5,000개 이하 권장(Vercel 본문 4.5 MB). 초과 시 413.
3. **멱등** — `(gateway, batch_id)` 같고 본문 해시 같으면 200 duplicate, 다르면 409. 샘플은 `(point_id, ts)` PK `ON CONFLICT DO NOTHING`. 파생 데이터는 모두 자연키 upsert.
4. **인코딩** — 정주기 `t0+dt` 또는 비정주기 `ts[]`. 결측은 `null`(0과 구분). 단위는 서버가 `point.scale/offset`으로 정규화.
5. **미매핑 태그** — 거부하지 않고 `unmapped_source`에 등록, 원본은 bronze 보존 → 매핑 후 replay.
6. **시계** — 미래 +5분 초과 거부. NTP 미동기 또는 |skew| > 120초면 `CLOCK_SUSPECT` 비트. 원시 ts는 자동 보정하지 않는다. 1시간 이상 늦은 샘플은 `LATE` 비트 + 롤업 재계산.
7. **셀 단위** — 셀 수백 개 원시값은 보내지 않고 랙·스택별 max/min/avg/spread + 위치 ID로 축약.
8. **안전 이벤트** — `asset_class.safety_event_codes`에 있는 코드(미등록 critical 포함)는 수집 트랜잭션 안에서 즉시 기록, 분석 우회.
9. **응답** — 200(accepted / duplicate / rejected / unmapped 카운트), 400(재시도 금지), 401(`X-OM-Server-Time`), 409, 413, 429/503(`Retry-After`).
10. **버전** — v1 안에서는 선택 필드 추가만. 깨지는 변경은 `/api/ingest/v2` 병행.

벤더 클라우드 API 폴링, CSV 업로드, 날씨·시장가격 같은 다른 입력도 **어댑터가 봉투로 변환해 같은 경로**로 넣는다(단일 입구). P1에서는 게이트웨이 푸시(시뮬레이터)와 OpenWeather 어댑터만 구현한다.

### 5.2 스키마 (`om`)

| 그룹 | 테이블 | 요점 |
|---|---|---|
| 카탈로그 | `site` | code(`SIM-B`), 좌표, timezone(기본 Asia/Seoul), attributes jsonb |
| | `asset_class` | key(`ess.rack`, `h2.elz.stack`, `fc.stack` …), level, parent_key, nameplate JSON Schema, safety_event_codes[] |
| | `asset` | site → system → asset → component 트리. class_key, path(`SIM-B/ESS1/RACK03`), nameplate jsonb, peer_group, criticality 1~5, commissioned_at |
| | `asset_event` | 교체·펌웨어·설정값 변경·정비. `resets_baseline` bool |
| | `metric_def` | key(`batt.soc`, `stack.voltage`, `h2.flow.mass`), 정규 단위, value_kind(gauge/counter/state/bool), rollup(twa/mean/sum/delta/integral/last/max/min), hard·expected 범위, 변화율·고착 파라미터, aliases jsonb. **메트릭 추가 = INSERT** |
| | `point` | (asset, metric_key, qualifier) ↔ (gateway, source_key), source_unit, scale, offset, period_s |
| | `gateway`, `gateway_key` | last_seen, last_seq, clock_offset / key_id, secret 암호화 저장, 활성 2개 회전 |
| 수집 | `ingest_batch` (bronze) | 원본 gzip, body_sha256, 처리 통계, status. 60일 보존 |
| | `unmapped_source` | (gateway, source_key), 첫/마지막 수신, 샘플 수 |
| | `measurement` (silver) | PK(point_id, ts), value float8, quality int2 비트(DEVICE_BAD, HARD_RANGE, SPIKE, FLATLINE, CLOCK_SUSPECT, LATE). **UTC 월 파티션** + DEFAULT, 파티션별 BRIN(minmax_multi). 원시 6개월 보존(기본값, 조정 가능) |
| | `event_log` | 이산 이벤트·고장코드, is_safety, acked_by/at |
| 파생 | `rollup_dirty` | 실제 삽입된 (point, hour)만 dirty 표시(gen 카운터) → 지연 도착 자동 재계산 |
| | `m_1h` | n, n_good, min/max/avg/first/last/sum/integral. 연 파티션, 영구 |
| | `episode` | PK(asset, kind, start_ts), extractor_version, features jsonb, conditions jsonb, dq jsonb, valid. **영구** — 원시 보존기간과 무관한 장기 비교의 근거 |
| | `kpi_daily` | (scope, day KST, kpi_key) → value, n, dq_completeness, calc_version. 영구 |
| | `site_energy_daily` | 체인 원장: flows_kwh, h2_kg(produced / stored_delta / fc_consumed / vented_est / residual), 전해조 계통전력 비율, SEC, P2P 효율, alloc_version (P3) |
| 분석 | `detector_config` | (detector, scope, version) → params, reference_window |
| | `finding` | dedup_key(탐지기·자산·고장모드, 창 제외), severity 1~5, confidence 0~1, category, status(new / triaged / in_report / action_taken / verified / dismissed / reopened), effect jsonb, detector_version, first/last_detected_at, detection_count, previous_finding_id, suppressed_until. 열린 건은 dedup_key당 1개(부분 유니크) |
| | `finding_evidence` | append-only 근거 스냅샷(input_hash, bin 통계, ≤120점 다운샘플 시계열) — 리포트 인용과 향후 LLM 입력의 원천 |
| | `finding_transition` | 상태 전이 이력. `verified`는 system만 |
| 코칭 | `maintenance_action` | action_type, performed_at, expected_effect{metric, direction, min_delta, stabilization_days} |
| | `action_verification` | before/after 창, 통계, effect, CI, verdict |
| | `report` | site, period, composer_id, pack jsonb, pack_hash, draft, validation, status(draft / reviewed / published / superseded) |
| | `report_delivery` | 채널, 수신자, 일시 |
| 운영 | `job_lease`, `watermark`, `job_run` | 크론 겹침 방지(만료 기반), 증분 워터마크, 실행 기록 |
| | `market_daily` | SMP/REC 등 수익 요약 위젯 입력(수기·CSV) |
| 인증 | `auth_*` | Better Auth 생성 SQL |
| 시뮬레이터 | `sim.run`, `sim.injection`, `sim.eval_result` | 로컬·CI 전용(RDS에는 생성 안 함) |

시간: DB는 `timestamptz`(UTC), 일 경계·화면·리포트는 KST.

용량 감각(추정): 사이트 30 × 포인트 500 × 1분 ≈ 50 GB/월 원시. 원시는 월 파티션 DROP으로 관리하고, 장기 비교는 영구 보존하는 `m_1h`·`episode`·`kpi_daily`로 한다. P1에서 로컬 100만 행 실측으로 보정.

### 5.3 분석 파이프라인

```
수집(요청마다)  HMAC → zod → normalize(순수) → measurement INSERT … RETURNING → rollup_dirty → 안전 이벤트 즉시 기록
tick (10분)    dirty 롤업(m_1h) → 게이트웨이 신선도 → 에피소드 추출(자산별 워터마크, 6시간 겹침 재처리)
daily (02:17)  파티션 생성·보존 → DQ 스윕 → kpi_daily → site_energy_daily → 탐지기 → finding upsert + evidence
               → 조치 효과 검증 → (월요일) EvidencePack → templateComposer → validateDraft → 리포트 초안
```

- 집합 집계는 SQL, 판단 로직은 **TypeScript 순수 함수**(now·rng 주입). `Detector { requires, load(ctx) /* I/O */, detect(input, ctx) /* 순수 */ }`.
- 모든 결과에 `detector_id@version`, `input_hash` 기록.
- 잡 규칙: `CRON_SECRET` 검사, `job_lease`, 시간 예산 내 자발 중단 + 워터마크 재개, 결과 upsert와 워터마크 전진은 같은 트랜잭션.
- 개발 단계에서는 같은 함수를 `npm run jobs:tick` / `jobs:daily`로 실행한다.

**통계 도구** (`lib/analytics/stats`, Vitest + fast-check): median / MAD / 수정 z-score(|M| > 3.5, MAD 하한), Hampel 필터, Theil–Sen 기울기 + CI, Mann–Kendall, 표 CUSUM(k=0.5, h=4~5), EWMA, `matchedRatio`(bin 가중 + 부트스트랩 CI), `scoreConfidence`(표본·CI 폭·DQ·방법 일치).

**판정 원칙**: 기상 영향은 사이트 내 동종 비교로 먼저 제거하고 일사계가 있으면 온도보정 PR 보조 / 출력제어·클리핑·정지 구간은 에피소드·KPI 단계에서 제외 / 수소 설비는 누적 운전시간 축, 초기 break-in 구간은 기준선 제외 / 안전 카테고리는 severity ≥ 4 고정 / 신뢰도 낮은 결과는 리포트에서 "관찰 중"으로만 표현.

**탐지기 로드맵**

| 단계 | 탐지기 |
|---|---|
| P2 (6종) | `dq.gap_flatline` · `ess.capacity_fade` · `ess.cell_imbalance` · `pv.inverter_peer` · `el.voltage_rise` · `fc.voltage_decay` |
| P3 (8종) | `el.sec_rise` · `h2chain.mass_balance_gap` · `tank.static_leak` · `comp.sec_rise` · `fc.blower_wear` · `pv.soiling_rate` · `ess.resistance_growth` · `inv.thermal_derating` |
| 이후 | YoY 열화(2년 데이터 후), 레인플로 피로, CHP 열회수, EIS·ICA 등 고해상도 진단 |

각 탐지기의 신호·탐지 방법·오탐 함정·권고 조치는 `research/research-*.json`의 `failureModes`를 플레이북 원천으로 쓴다.

### 5.4 LLM 연결 지점 (이번엔 인터페이스만)

1. **EvidencePack** `om.evidence-pack.v1` — site, period, kpis, energyLedger, findings[]{effect+CI, evidence(≤120점), playbook, history}, dataQuality, verifiedActions, revenueSummary, provenance{engineVersion, packHash}. **원시 시계열은 넣지 않는다.**
2. **ReportComposer** — `compose(pack, opts) → ReportDraft{composerId, packHash, sections[]{kind, blocks[]{text, citations[]}}}`. 구현체는 `templateComposer@1`(탐지기별 한국어 메시지 템플릿 + 플레이북) 하나.
3. **validateDraft** — 인용 id 존재, 본문 수치 = evidence 값(표시 반올림 허용), severity ≥ 4 전부 언급, 금지 표현(법정 안전 판단 대체) 없음.

나중에 `LlmComposer`를 추가해도 validateDraft를 통과해야 채택되고 실패 시 템플릿으로 폴백한다. 바뀌는 것은 문장 품질뿐이다. 외부 LLM으로 사이트 데이터를 보내도 되는지는 그 단계 착수 전에 정책으로 결정한다.

### 5.5 시뮬레이터 (실데이터 대체 + 정답 기반 검증)

- `lib/sim`: 시드 PRNG, 합성 기상(청천일사 × 운량 AR(1), 계절·일변화 기온, 강우), 근사 물리 모델 — PV/인버터, 배터리(용량·SOC 적분·OCV + IR·CC-CV·저온 용량 감소), 전해조(V_cell = E_rev + b·ln j + r·j + δ·운전시간, 패러데이 H₂), 압축기·탱크(질량수지, Z 보정), 연료전지(분극곡선 + 운전시간 감쇠, 블로워 P ∝ Q³).
- 사이트 3곳: **SIM-A** 영암(PV 1 MWp 인버터 4대 + ESS 2 MWh 랙 4개), **SIM-B** 새만금(PV 2 MWp + ESS 1 MWh + PEM 전해조 500 kW + 압축기·저장뱅크 + PEMFC 200 kW), **SIM-C** 제주(SIM-B와 동일 구성, 고장 없음 = 음성 대조군).
- 시나리오 — 고장: 배터리 용량 감소(1~10%), 셀 불균형, 인버터 효율 저하(0.5~3%p), 전해조 스택 열화(5~40 µV/h/셀), 연료전지 전압 감쇠. 데이터 품질: 게이트웨이 6시간 단절 후 역순 백필, 센서 고착, 스파이크, 중복 배치 5%, 시계 오차 +200초. 음성 대조군: 한파 주간, 흐린 주, 출력제어 3회, 전해조 부분부하 주간, 연료전지 잦은 기동정지, SOC 상한 설정 변경.
- 두 모드: **메모리 모드**(12개월 × 1분을 순수 함수로 하루씩 재생 → 재현율·정밀도·자산월당 오탐·탐지 지연·크기 MAE) / **DB E2E 모드**(30일 × 3사이트를 실제 `/api/ingest/v1`로 POST).
- CI 게이트(초기값): `ess.capacity_fade` 5% 이상에서 재현율 ≥ 0.9 · 크기 MAE ≤ 1%p · 지연 ≤ 21일 / 전 탐지기 오탐 ≤ 0.1건/자산·월(대조군 포함) / `el.voltage_rise` 20 µV/h 이상에서 재현율 ≥ 0.9.

## 6. 기술 스택

| 영역 | 현재 | 변경 | 이유 |
|---|---|---|---|
| 프레임워크 | Next 16.1.1, React 19.2.3 | **Next 16.3.5, React 19.3.0** (첫 커밋) | critical 취약점(Proxy 우회, Server Action CSRF 등) 해결. 확인: `npm audit` |
| 렌더링 | 단일 클라이언트 페이지 + 폴링 | RSC + `server-only` DAL로 DB 직접 조회, 변경은 Server Action + zod. Route Handler는 ingest / cron / auth / series만 | Next 16 문서 권고. 준실시간은 탭이 보일 때만 `router.refresh` |
| DB 접근 | pg Pool, `any` | pg 8.23 + **Kysely 0.29** + kysely-codegen(DB → TS 타입) | SQL 중심 분석(파티션, BRIN, date_bin)과 타입 안전 |
| 마이그레이션 | 없음 | **node-pg-migrate 9** (순수 `.sql`, advisory lock) | 로컬 DB와 RDS에 동일 적용. Drizzle Kit은 PARTITION BY 미지원 |
| 로컬 DB | 없음 | **embedded-postgres** — 실제 PostgreSQL 바이너리를 npm으로 받아 일반 프로세스로 실행(포트 54320, 테스트 DB 포함). Docker 미사용 | 운영 RDS 무접촉 개발. Docker Desktop이 개발 PC에서 블루스크린 유발 |
| 인증 | 없음 | **Better Auth 1.7** (이메일+비밀번호, 가입 비활성, admin, DB 세션·rate limit) + `proxy.ts` 낙관 검사 + 모든 page/action/handler 첫 줄 `requireAdmin()` | Auth.js v5는 베타·유지보수 모드. Proxy 우회 advisory 이력 때문에 DAL 검사 필수 |
| 차트 | Chart.js 4 | **ECharts 6.1** (echarts/core 트리셰이킹 + 자체 래퍼) | 수만 포인트 줌·다중축·이벤트 밴드·차트 커서 동기화·서버 SVG(리포트) |
| 지도 | Kakao SDK 수동 + innerHTML, 미사용 leaflet | **react-kakao-maps-sdk 1.2** (선언형), leaflet 계열 삭제 | XSS 제거, 타입 |
| 아이콘 | Font Awesome CDN | **lucide-react** | 렌더 차단 CSS 제거, 트리셰이킹 |
| 검증 | 없음 | **zod 4.6** | 수신 페이로드·폼·쿼리·환경변수 |
| 테스트 | 없음 | **Vitest 5** (unit: `lib/analytics` 커버리지 80% / integration: 로컬 테스트 DB) + fast-check + **Playwright 1.63** (프로덕션 빌드, chromium) | 순수 함수 TDD, 인증 차단·폐루프 E2E |
| 스크립트 | 없음 | tsx (`db:up`, `db:migrate`, `db:types`, `db:seed`, `sim:backfill`, `sim:live`, `sim:eval`, `jobs:tick`, `jobs:daily`, `admin:create`) | Node 네이티브 TS는 `@/` 경로 미해석 |
| 배포 | Vercel(Hobby 추정) | Vercel, region `icn1`, 크론 2개(tick 10분, daily) | Hobby는 상업 이용 불가·크론 1일 1회 → 운영 전환 시 Pro 필요 |

기타: `.gitattributes`(eol=lf), `lib/env.ts`(zod 환경변수 검증), RDS TLS CA 검증.

## 7. 디렉터리 (목표)

```
app/
  layout.tsx
  (auth)/login/
  (console)/layout.tsx           셸(사이드바·상단바)
  (console)/page.tsx             오늘
  (console)/fleet/ sites/ explore/ desk/ reports/ actions/ safety/ data/ settings/ sim/
  api/ingest/v1/  api/cron/{tick,daily}/  api/auth/[...all]/  api/series/
proxy.ts
lib/
  env.ts  brand.ts
  db/        pool, kysely, types(생성)
  auth/      auth, dal(requireAdmin)
  data/      화면용 조회(server-only)
  ingest/    envelope(zod), normalize(순수), hmac, store
  analytics/ stats/ episodes/ kpi/ detectors/ pipeline/
  report/    evidence-pack, composer, template-composer, validate, messages/, playbooks/
  verification/
  jobs/      lease, tick, daily
  sim/       rng, weather, models/, scenarios, emit, truth, evaluate
components/  ui/ charts/ map/ console/
db/migrations/*.sql
scripts/     tsx 진입점
tests/e2e/
scripts/db-server.ts   embedded-postgres 로컬 DB 서버
```

## 8. 단계별 로드맵

| 단계 | 목표 | 산출물 | 완료 기준 | 실행 |
|---|---|---|---|---|
| **P0 기반 정리·리브랜딩** | 보안 구멍과 데이터 오염원 제거, DB·인증·콘솔 셸 | Next 16.3.5 업그레이드(별도 커밋) · 브라우저 시뮬레이터 / 인증 없는 POST / 24h 삭제 크론 / weather-history / leaflet 제거 · embedded-postgres + node-pg-migrate + Kysely · Better Auth + proxy + DAL · `(auth)`/`(console)` 셸, 새 브랜드, lucide · ECharts 래퍼 · Vitest/Playwright 골격 | `npm audit`에 next 0건 · `next build` 통과 · 빈 DB에 migrate up 2회 무오류 · 비로그인 E2E로 콘솔 URL·Server Action·`/api/series` 전부 차단 | Claude (로컬) |
| **P1 수집 원장 + 시뮬레이터** | 계약 없이 받고, 원본 보존하고, 재처리 | `/api/ingest/v1`(HMAC·gzip·멱등 3중·bronze·미매핑·안전 즉시 경로) · 카탈로그 시드(리서치 기반 asset_class·metric_def) · measurement 월 파티션 + dirty 롤업 + 기본 DQ · 시뮬레이터 6개 모델 + HTTP emit + SIM-A/B/C · OpenWeather 어댑터(서버) · 화면: 오늘(골격), 플릿, 사이트, 자산 상세, 탐색기, 안전, 데이터, 설정/카탈로그 | 30일 × 3사이트를 HTTP 적재(중복 5% + 6시간 단절 백필 포함) 시 행 수 기대치 정확 일치 · m_1h = 원시 재집계 · 미매핑 태그 매핑 후 replay로 과거 표시 · 안전 이벤트 수신 → 배너 | Claude (로컬) |
| **P2 분석 데스크 MVP** | 배터리 예시를 원시 → 리포트 → 조치 검증까지 닫기 (태양광·ESS·전해조·연료전지 포함) | 에피소드 추출기(ess / pv / el / fc) · 통계 도구 · 탐지기 6종 + detector_config · finding / evidence / transition · 분석 데스크(인박스, 증거 캔버스, 에피소드 오버레이, 판별 체크, 권고) · 조치 추적 + 전후 검증 · EvidencePack + templateComposer + validateDraft + 리포트 검토·인쇄 · sim:eval 게이트 + /sim · 오늘 화면 완성 | CI 게이트 통과(§5.5) · 용량 −6.25% 주입을 −6.25% ± 1%p로 추정 · SOC 상한 변경을 기각 사유로 입력하면 해당 오탐 소멸 · 밸런싱 조치가 `improved` → `verified` 전이 E2E · SIM-B 주간 리포트가 sev ≥ 4 전부 인용하고 validateDraft 통과 · `lib/analytics` 커버리지 80% | Claude (로컬) |
| **P3 수소 체인 심화** | 저장·압축·연료전지 BoP와 사이트 체인 원장 | 탐지기 8종(§5.3) · `site_energy_daily` + 체인 Sankey + 물질수지 잔차 + 전해조 계통전력 비율 · PV 미활용 원인 분해 · 탐지 준비도 매트릭스 · 탐지기 설정 UI | 신규 시나리오 게이트 편입·기존 회귀 없음 · 건강한 사이트 물질수지 잔차 < 1% · 탱크 미세누설 최소 탐지 크기 곡선 산출 · 출력제어·흐린 주 대조군에서 PV finding 0건 | Claude (로컬) |
| **P4 운영 전환·파일럿** | 실제 RDS·Vercel·첫 실사이트 | RDS에 마이그레이션 적용(로컬/CI에서 실행) · 기존 `solar_sites`·`solar_weather_history` 이관, 가짜 테이블 백업 후 정리 · Vercel Pro·icn1·크론·CRON_SECRET · 파일럿 게이트웨이 키·매핑·replay·기준선 재학습 · 보존 잡 · 관리자 2FA | 파일럿 30일 수집 완결성 ≥ 95% · 잡 7일 연속 정상 · 기각 사유 파레토 확보 · 월 인프라 비용 합의 상한 이내 | **사용자 인프라 결정 필요** |
| **P5 LLM (선택)** | 리포트 문장 품질만 개선 | 데이터 반출 정책 · LlmComposer(구조화 출력) + validateDraft + 폴백 · 같은 팩 비교 화면 | 보관 팩 50개 이상 validateDraft 통과율 ≥ 95% · 검토자 선호도 우세 | 별도 승인 |

## 9. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 소규모 팀에 과한 복잡도 | 단계 게이트: 테이블은 필요한 단계에만 추가, P2 탐지기 6종 상한, 케이스·섀도·재처리 UI 등 미룸(§4.2) |
| 시뮬레이터 과적합 → 현장 오탐 | 임계값 옆 "추정 임계" 표시, detector_config로 배포 없이 조정, P4 파일럿에서 기준선 재학습·기각 사유 파레토 |
| 태양광 연계 ESS는 저 SOC → 만충 앵커 세션이 드묾, LFP OCV 평탄 | `insufficient` 명시, CV 종료 상단 앵커·CC 구간 Ah 보조 지표, 정기 용량시험 입력 |
| 데이터 계약상 핵심 포인트(휴지 OCV, 셀 max/min, 유량계) 누락 | 탐지 준비도 매트릭스와 [데이터 계약 초안](data-contract-draft.md)으로 필요한 포인트를 먼저 합의 |
| 현장 게이트웨이가 HMAC 서명·HTTPS 푸시를 못 함 | 벤더 API 폴링·CSV 어댑터 또는 엣지 릴레이로 봉투 변환(단일 입구 유지). P4 파일럿에서 확인 |
| Vercel Hobby: 상업 이용 불가, 크론 1일 1회 | 개발은 npm 스크립트, 운영 전 Pro 전환 또는 잡 진입점을 외부 스케줄러로 이동(순수 함수·SQL 그대로) |
| RDS 스토리지 급증 | 게이트웨이 축약 규칙 계약 명시, 원시 6개월 파티션 DROP, 장기 비교는 episode·m_1h, P1 실측 보정 |
| RDS 퍼블릭 엔드포인트·TLS 검증 끔 | CA 검증, 보안그룹 최소화, 최소 권한 DB 계정, 키 회전 |
| 콘솔을 안전설비로 오인 | 안전 레인 분리, 고정 문구 "법정 안전설비·PLC 인터록을 대체하지 않음", 통신 두절 시 불확실 표시 |
| 체인 원장 할당 근사·미계측 엣지 | alloc_version·completeness·불확도 표시, 추정 엣지만으로 sev ≥ 4 발행 금지, 청정수소 인증 공식 산정 아님 명시 |
| 신규 메이저 의존성(Vitest 5, ECharts 6, Better Auth) | 정확한 버전 고정, 미사용 플러그인 미설치, 인증은 DAL 뒤에 숨겨 교체 가능, 문제 시 Vitest 4.1 |

## 10. 범위 밖 (영구 또는 이번 리뉴얼)

현장 설비 제어·설정 쓰기, 안전 인터록 실행(영구) · 발전소 사용자 계정·포털 · CMMS 전체 기능 · SMP/REC 정산·입찰·예측, 청정수소 인증 공식 산정 · SSE/WebSocket·MQTT 상시 연결 · Python 분석 워커 · 모바일 앱·다국어 · 원시 S3 아카이브(P4 이후 필요 시).

## 11. 운영 전환(P4) 전에 확인할 것

P0~P3는 아래 답 없이 기본값으로 진행할 수 있다.

1. 기존 RDS PostgreSQL 메이저 버전·리전·퍼블릭 접근 여부 (기본값: 로컬 PG 17, 15+ 호환 기능만 사용)
2. Vercel 요금제 — Pro 전환 가능 여부
3. 사이트 데이터 실제 경로(게이트웨이 푸시 / SCADA·RTU / 벤더 클라우드 / CSV)와 사이트당 포인트 수·주기
4. PV 사이트 경사면 일사계·모듈온도 센서 유무, 출력제어 신호 수집 가능 여부
5. 수소 설비 사양(전해조 방식·셀 수, 저장 압력·용적, 연료전지 종류·제조사 제공 데이터)
6. 원시 보존기간(기본 6개월)과 S3 아카이브 허용 여부
7. 정비 이력 보관 위치(CMMS / 엑셀 / 없음)
8. 코칭 리포트 수신자·주기·전달 방식(콘솔 열람 / PDF / 이메일)
9. 관리자 수, 2FA·IP 허용목록·사내 SSO 필요 여부
10. 기존 `solar_sites`·`solar_weather_history` 이관 여부, 가짜 테이블(stats/market/schedule/revenue/actions) 백업 후 삭제 여부
11. 향후 LLM에 사이트 운영 데이터 전송 가능 여부(보안·계약)

## 12. 제품명

| 후보 | 의미 |
|---|---|
| **HySol Desk (하이솔 데스크) — 선택** | Hydrogen + Solar, 분석 데스크 |
| EnerChain O&M | 태양광 → 수소 → 연료전지 에너지 체인 |
| CoachDesk (코치데스크) | 발전소 유지보수 코칭이라는 목적 강조 |

코드 내부 명칭은 제품명과 분리한다: DB 스키마 `om`, API `/api/ingest/v1`, 표시명은 `lib/brand.ts` 한 곳.

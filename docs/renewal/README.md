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

## 13. 구현 반영 (P1~P3 실제 구현과 설계의 차이)

- 기준: 2026-09-15, 브랜치 `renewal/om-console` 커밋 `0b96129`.
- 이 절은 §0~§12 본문을 고치지 않고, 구현이 본문과 **달라진 곳만** 적는다. 본문과 이 절이 다르면 이 절이 현재 코드의 동작이다. §0 확정 결정은 모두 지켰다.
- 근거는 코드, 마이그레이션, `lib/analytics/scorecard.json`, 커밋 메시지다. 수치는 코드 기본값과 스코어카드에서 그대로 옮겼다. 평가 수치는 모두 시뮬레이터 결과이고 실데이터로 검증한 값이 아니다.
- 이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않는다. 아래의 안전 관련 기준값은 모두 분석을 돕는 값이다.

### 13.1 수집·저장 (P1)

| 항목 | 설계 원문 요지 | 실제 구현 | 이유 | 관련 파일 · 커밋 |
|---|---|---|---|---|
| 품질 비트 | §5.2 `quality` 비트 6종 (DEVICE_BAD·HARD_RANGE·SPIKE·FLATLINE·CLOCK_SUSPECT·LATE) | 비트는 7종이다(REPROCESSED=64 추가). `BAD_MASK`(DEVICE_BAD·HARD_RANGE·SPIKE·FLATLINE)와 `INFO_MASK`(CLOCK_SUSPECT·LATE·REPROCESSED)로 나눴다. `m_1h.n_good`은 값이 NULL이 아니고 BAD 비트가 없는 샘플 수다. NULL 값은 n에는 넣고 min·max·avg·sum·first·last에서는 뺀다. 시각이 판정에 들어가는 분석은 `isGoodWithTrustedClock`으로 CLOCK_SUSPECT 샘플도 뺀다. `npm run db:rollup:rebuild`로 로컬 m_1h를 다시 계산한다 | 과거 적재분에 LATE 비트가 붙어 `n_good`이 거의 0이 되던 문제 | `lib/ingest/quality.ts`, `scripts/db-rollup-rebuild.ts` · `81af045` |
| 시계 오차 측정 | §5.1 규칙 6: NTP 미동기이거나 skew가 120초를 넘으면 CLOCK_SUSPECT. 무엇을 기준으로 skew를 재는지는 정하지 않음(봉투에 `sent_at`이 있음) | skew = 서명 시각(`X-OM-Timestamp`, 초 해상도) − 서버 수신 시각이다. 한계 120초는 그대로다. 재처리(replay)는 수신 때 저장한 `ingest_batch.skew_ms`를 쓴다. 원시 ts는 보정하지 않는다 | 재전송 본문의 `sent_at`은 오래된 값일 수 있다(시뮬레이터 재실행을 duplicate로 멱등화하면서 `sent_at`을 전송 시각으로 다시 찍지 않게 함) | `lib/ingest/normalize.ts`(`clockSkewFromSignature`, `CLOCK_SKEW_LIMIT_MS`) · `bce1243` |
| 원시·원본 보존 | §5.2 `measurement` 원시 6개월, `ingest_batch` 60일 보존. §5.3 daily 잡에서 파티션 생성·보존. §9 원시 6개월 파티션 DROP | §0 결정대로 **영구 보관**한다. 원시 파티션이나 bronze 원본을 지우는 함수·잡이 없다. `measurement`는 UTC 월 파티션 + DEFAULT이고, 마이그레이션이 −3~+3개월 파티션을 미리 만든다(`om.ensure_measurement_partitions`). 수집은 저장 직전의 별도 트랜잭션에서 필요한 파티션을 준비한다. `m_1h`는 UTC 연 파티션이다 | §0 확정 결정(원시 영구 보관) | `db/migrations/20260914090759273_om-ingest-measurement.sql`, `db/migrations/20260914090800923_om-rollup-market.sql`, `lib/ingest/store.ts` · `20d4c80`, `0991222` |
| 롤업 시점 | §5.3 tick(10분) 크론이 dirty 롤업 | 수집 응답 뒤 `after()`에서 그 배치 포인트의 dirty 시간을 처리한다. 분석 실행을 시작하면 남은 dirty를 먼저 처리한다 | §0 확정 결정(크론 없음) | `app/api/ingest/v1/route.ts`, `lib/ingest/rollup.ts`, `lib/analysis/run.ts` · `0991222`, `4165ab0` |
| 시뮬레이터 스키마 | §5.2 `sim.run`·`sim.injection`·`sim.eval_result`는 로컬·CI 전용(RDS에는 생성 안 함) | 일반 마이그레이션 폴더 `db/migrations`에 별도 파일로 들어 있다. 그래서 RDS에 `db:migrate`를 적용하면 `sim` 스키마와 **빈 테이블 3개**가 생긴다. 콘솔·수집 코드는 `sim`을 참조하지 않는다. `/sim` 화면은 `HYSOL_SHOW_SIM=1`일 때만 열린다 | node-pg-migrate가 적용 순서를 검사하므로 운영에서도 이 파일을 건너뛰지 않고 함께 적용한다(마이그레이션 주석). om 행과 FK로 묶지 않아 운영 데이터와 연결되지 않는다 | `db/migrations/20260914150343350_sim-eval-schema.sql`, `lib/data/sim-console.ts` · `2a4e8f5` |

### 13.2 분석 실행·리포트·설정 (P2~P3)

| 항목 | 설계 원문 요지 | 실제 구현 | 이유 | 관련 파일 · 커밋 |
|---|---|---|---|---|
| 분석 실행 | §5.3 tick/daily 크론, `job_lease`·`watermark`·`job_run`, `CRON_SECRET`, `npm run jobs:tick`·`jobs:daily`. §6 Vercel 크론 2개 | **수동 실행만 있다.** 크론 라우트, 잡 스크립트, 잡 테이블은 만들지 않았다. 설계의 파이프라인 함수를 관리자가 `/desk`의 "분석 실행"이나 `npm run analyze`로 돌린다.<br>· 실행 기록: `om.analysis_run`(running·succeeded·failed·partial)<br>· 동시 실행 방지: 사이트별 `pg_try_advisory_xact_lock`<br>· 시간 예산: 실행기 기본 15분, `/desk` 버튼 실행은 10분. 넘으면 partial<br>· 에피소드 재처리 겹침: 6시간<br>· 중단 실행 정리: 잠금을 잡은 뒤 자기 사이트의 running 행 중 `started_at < now − 예산×2`인 것만 failed로 바꾼다<br>· 단계 순서: dirty 롤업 → 추출 → 일 KPI → 보조 입력 → 탐지 → 체인 원장 → finding → 조치 효과 검증. `pv.soiling_rate`는 원장보다 먼저, 물질수지는 원장 뒤에 실행한다 | §0 확정 결정(분석은 수동 실행만) | `lib/analysis/run.ts`, `lib/analysis/site-run.ts`, `lib/analysis/lock.ts`, `scripts/analyze.ts`, `db/migrations/20260914150340633_om-analysis-coaching.sql` · `4165ab0`, `7510d02`, `4f4a0b7`, `500caab`, `8a5c4d4` |
| 리포트 상태·전달 | §5.2 `report.status`(draft·reviewed·published·superseded)와 `report_delivery`(채널·수신자·일시). §4 "전달 기록". §5.3 월요일 자동 초안 | 상태는 **draft·approved·superseded** 세 가지다.<br>· 사이트·기간당 approved는 1개(부분 유니크)다.<br>· 승인하면 포함된 finding이 `in_report`가 되고, 같은 기간의 이전 리포트는 superseded가 된다.<br>· `report_delivery` 테이블과 메일 발송은 없다. 출력은 인쇄 화면(`/reports/[id]/print`)에서 브라우저 PDF로 저장한다.<br>· 초안은 "리포트 만들기" 버튼으로만 만든다. 팩이 같으면 기존 행을 쓴다.<br>· 엔진 `report-planner@2`, 문장 템플릿 `report-messages@2`, composer `templateComposer@1` | §0 확정 결정(분석과 출력 분리, 메일 없음) | `db/migrations/20260914150340633_om-analysis-coaching.sql`, `lib/report/`, `app/(console)/reports/` · `2a4e8f5`, `889728a`, `5076ccc`, `c4ae998` |
| 사이트 단위 finding | §5.2 dedup_key(탐지기·자산·고장모드) | `h2chain.mass_balance_gap`과 `pv.soiling_rate`는 finding을 사이트 단위로 남긴다. `asset_id`는 NULL이고 dedup_key의 설비 자리에 `site:<id>`가 들어간다. 워크스페이스에서는 사이트 단위 finding의 조치를 직접 기록하지 않고 안내만 한다(세척은 조치 추적에서 설비로 기록) | 두 탐지기는 사이트 전체의 일 원장·인버터 전체를 한 번에 판정한다 | `lib/analysis/findings.ts`, `lib/analytics/pipeline/targets.ts` · `8a5c4d4`, `1eb6292` |
| 안전 카테고리 | §5.3 안전 카테고리는 severity ≥ 4 고정 | DB CHECK로 category safety면 severity ≥ 4다.<br>· `tank.static_leak`만 두 가지를 낸다: 누설률 CI 하한이 `safetyKgPerDay`(0.5 kg/일)를 넘으면 safety·4, 유의하지만 그 미만이면 performance·3.<br>· 열린 finding을 갱신할 때 심각도와 함께 카테고리도 바꾼다.<br>· "안전 발견사항"(오늘 배너, 리포트 즉시 확인 블록)은 category safety이면서 severity ≥ 4인 열린 finding이다 | 갱신 때 카테고리를 그대로 두면 4→3에서 CHECK 위반으로 findings 단계가 실패하고, 3→4에서 안전 배너·즉시 확인 블록에서 빠졌다 | `lib/analysis/findings.ts`, `lib/desk/safety.ts`, `lib/analytics/detectors/tank-static-leak.ts` · `73282b6`, `3626588` |
| 탐지기 설정 | §5.2 `detector_config`(detector, scope, version) → params, reference_window. §4 설정 화면 | · 병합 순서는 asset > class > default다. 병합 뒤 `paramSchema`(zod)로 검증하고, 실패하면 그 탐지기는 `insufficient`(invalid_config)다.<br>· 근거 스냅샷에 적용 설정 `{scope, version, params_hash}`를 남긴다.<br>· 설정 화면은 실행에 적용되는 범위만 고르게 한다: 물질수지·데이터 품질은 default만, 인버터 동종 비교·열 저감은 default·class, 나머지는 asset까지.<br>· 빈 칸은 저장하지 않고 넓은 범위의 값을 물려받는다 | 적용되지 않는 범위에 저장한 설정은 분석에서 조용히 무시되기 때문이다 | `lib/analytics/pipeline/config.ts`, `lib/analytics/pipeline/targets.ts`, `lib/detector-config/`, `app/(console)/settings/detectors/` · `8a5c4d4`, `b7e974e` |

### 13.3 탐지 방법 변경

| 항목 | 설계 원문 요지 | 실제 구현 | 이유 (전/후 수치는 sim:eval) | 관련 파일 · 커밋 |
|---|---|---|---|---|
| `ess.capacity_fade` 비교 창·기준 | §3.1 기준 창(준공 후 30~120일, 첫 유효 20세션) vs 최근 30일. C-rate 0.05C × 셀온도 5 °C bin. bin당 5개·전체 15개 미만이면 insufficient | · 최근 기간 21일, bin당 최소 3개, 최근 합계 15개. bin 폭 두 값은 탐지기 설정으로 옮겼다(값은 그대로).<br>· 기준은 bin마다 가장 이른 5개다(`referencePerBin`). 최근 가중치가 가장 큰 bin(주 bin)의 기준 시점과 120일 넘게 떨어진 bin은 결합에서 뺀다. 근거에 bin별 기준 기간과 제외 이유를 남긴다.<br>· `detector_config.reference_window`가 있으면 그 창을 우선한다.<br>· bin 안에서는 가중 중앙값, bin끼리는 최근 가중치 합으로 결합한다. CI는 부트스트랩 | · 5% 이상 탐지 지연 중앙값 23일 → 19일 (`f36ef2b`)<br>· 연계형 SIM-B 판정 불능 약 95% → 0%, 여름 연속 판정 불능 약 5개월 → 0일 (`64cefa4`) | `lib/analytics/detectors/ess-capacity-{fade,reference}.ts` · `f36ef2b`, `64cefa4` |
| `ess.capacity_fade` 용량 추정 방식 | §3.1 유효 앵커 세션(휴지 후 시작 SOC ≤ 20%, CV 종료)의 `capacity_ah = ah_in / (1 − soc_start)`. §9 CV 종료 상단 앵커·CC 구간 Ah 보조 | 네 방식을 **CV 종료 앵커(`capacity_ah_anchored`) > 휴지 앵커(`rest_anchored`) > CC 구간 Ah(`capacity_ah_cc`) > 부분 충전 SOC 변화(`capacity_ah_soc`)** 순으로 쓴다. 앞 방식이 판정 불능이면 다음 방식으로 넘어간다.<br>· 휴지 앵커: 30분 이상 휴지 끝 SOC 두 점 사이 순 Ah ÷ ΔSOC. ΔSOC 25%p 이상, 쌍 길이 36시간 이하, 사이 에피소드 덮음 98% 이상. 가중치는 추정 상대분산의 역수(SOC 1σ 1%p, 전류 적분 0.5%). bin은 충전·방전 방향 × 셀온도.<br>· SOC 변화 방식: 충전 Ah ÷ SOC 변화(SOC 변화 40% 이상).<br>· SOC를 쓰는 방식은 근거에 "BMS SOC 재보정 품질에 의존" 주의 코드를 남기고 화면·리포트에 문구로 보인다.<br>· 휴지 에피소드 추출기는 `ess.rest@2`(휴지 끝 SOC, 휴지 중 순 Ah 추가) | · 시뮬레이터 EMS가 SOC 90%에서 충전을 멈춰 앵커·CC 세션이 생기지 않는다<br>· 휴지 끝 SOC는 BMS가 휴지 OCV로 재보정했을 가능성이 높아, 충전 중 순간 SOC보다 순환 논리가 약하다<br>· CC 방식도 순간 SOC에 의존해 휴지 앵커 뒤에 둔다<br>· 방향마다 쿨롱 효율과 LFP OCV 히스테리시스가 달라 방향으로 bin을 나눈다 | `lib/analytics/detectors/ess-capacity-samples.ts`, `lib/analytics/episodes/ess.ts` · `f36ef2b`, `64cefa4` |
| 스택 전압: 변화점 이후 기울기 | §4.1·§5.3 누적 운전시간 축 Theil–Sen µV/h + CUSUM 변화시점 | `el.voltage_rise`·`fc.voltage_decay` 공통. CUSUM 변화 시작점 뒤 누적 운전시간이 300 h(`minHoursAfterChange`) 이상이고 변화 전·후 기울기 95% CI가 겹치지 않으면, 변화점 이후 Theil–Sen 기울기를 효과로 쓴다. 조건이 안 맞으면 전체 기울기를 쓴다. 전체·변화 전 기울기는 근거에 남긴다 | · 열화율이 도중에 바뀐 스택에서 전체 기울기가 낮게 잡혔다(unit 재현: 4 → 25 µV/h 주입에서 전체 기울기 22.5 µV/h 미만, 변경 뒤 효과 25 ± 2.5 µV/h 안)<br>· CI 분리 조건은 기울기가 일정한 열화에서도 CUSUM이 변화점을 내 45 µV/h가 39.2 µV/h로 잡히던 문제를 막는다 | `lib/analytics/detectors/stack-voltage.ts` · `8152a95` |
| `fc.voltage_decay` 보정 방식 | §3 같은 조건 비교 일반형(전류밀도·온도 bin + bin 안 보정) | · `correctCurrentDensity`·`correctTemperature` = false: 전류밀도 bin과 bin 안 회귀를 끄고 온도 bin만 쓴다.<br>· 전압은 기준 전류밀도 환산값 `v_cell_at_jref`만 쓴다.<br>· 추출기 기준 전류밀도 0.5 → 0.6 A/cm², 분극 기울기 0.25 → 0.2 V/(A/cm²), 환산 허용 거리 0.25 → 0.3 | · 정출력 운전에서 전압이 떨어지면 전류밀도·온도가 함께 올라 bin 안 회귀가 열화를 지웠다(20·40 µV/h 주입 0/6 탐지)<br>· 변경 뒤 20·40 µV/h 각 3/3, 20 µV/h 이상 크기 상대오차 중앙값 0.034 | `lib/analytics/detectors/stack-detectors.ts`, `lib/analytics/episodes/stack-episodes.ts` · `f36ef2b` |
| `el.voltage_rise` 전류밀도 보정 | §3 전류밀도·온도 bin 비교 | `currentDensityMode` 기본값은 `reference_slope`다. 전류밀도 bin 없이 기준 구간(break-in 이후 점의 앞 25%)에서 잰 전압–전류밀도 기울기 하나로 모든 점을 보정한다. `bins` 방식은 설정으로 고를 수 있다 | · 전력 설정값 운전에서 정류기 효율이 떨어지면 같은 전력의 전류밀도가 3~5% 옮겨 가, bin 중앙값 빼기가 열화를 지웠다(데모 정류기 고장이 겹치면 finding 없음)<br>· 10 µV/h 탐지 지연 72 → 40일, 20 µV/h 이상 상대오차 중앙값 0.038 → 0.003, 오탐 0 유지 | `lib/analytics/detectors/stack-voltage.ts` · `038cfd1` |
| `pv.inverter_peer` MAD 하한 | §5.3 수정 z-score(절댓값 3.5 초과, MAD 하한) | MAD 하한 = 동종 중앙값 × `madFloorRatio`, 0.005 → **0.003**. z 기준 −3.5, 최근 7일 중 5일 조건은 그대로다 | · 동종 4대에서는 MAD가 거의 항상 하한이라 하한이 곧 임계다<br>· 유효 탐지 편차 약 2.6% → 1.6%, 인버터 2%p 저하 0/3 → 3/3, 1%p 0/3 그대로, 대조군 포함 오탐 0 | `lib/analytics/detectors/pv-inverter-peer.ts` · `4f4a0b7` |
| `dq.gap_flatline` 고착 규칙 | §5.2 `metric_def` 고착 파라미터, §4.1 데이터 품질도 코칭 항목 | · 고착 구간 끝 = 마지막 샘플 + 주기, 길이 기준은 "이상(≥)".<br>· 일사량(POA·GHI) 고착 기준 2시간, 절댓값 5 W/m² 이하 구간(야간)은 뺀다.<br>· DB 경로와 메모리 평가가 같은 순수 요약 함수를 쓴다 | · 시뮬레이터 6시간 고착이 5시간 55분으로 재져 6시간 기준에서 빠졌다<br>· 운영 DB 탐지 결과도 이 규칙으로 바뀐다 | `lib/analytics/dq/summary.ts`, `db/seed/catalog.ts` · `8152a95` |
| `el.sec_rise` 운전 조건 bin | §5.3 P3 로드맵에 이름만 | 운전 조건 bin 기본값은 설비 AC 전력 50 kW(`binBy ac_power`)다. 전류 설정값으로 운전하는 설비는 `current_density`로 되돌린다. 판별 체크 5종: 스택 전압 상승 동반, 정류기 효율 저하, 패러데이 효율 저하, 부분부하 비중 증가, 퍼지 횟수 증가 | · 전력 설정값 운전에서 정류기·스택이 열화하면 전류밀도 bin 기준이 고장 뒤 표본으로 새로 생겨 상승이 가려졌다(정류기 10% 주입: 월 중앙 SEC 57.7 → 63.2 kWh/kg인데 finding 0)<br>· 5% 이상 재현율 0.5 → 1.0, 오탐 0 | `lib/analytics/detectors/el-sec-rise.ts` · `61060df`, `038cfd1` |
| `comp.sec_rise` 운전 필터 | §5.3 이름만 | · 운전 최소 이송량 1 → 5 kg(`minMassKg`).<br>· bin: 압력비 2 × 흡입 온도 5 °C. 흡입 가스 온도 메트릭이 카탈로그에 없어 외기 온도(`ambient.temp`)로 대신한다.<br>· 누설 감지 압력 상승은 판별 체크로만 쓰고 별도 safety finding은 내지 않는다 | · 1~2 kg 보충 운전은 비에너지가 약 3.0 kWh/kg(정상 약 1.9)이라 기준 bin에 섞이면 CI가 0을 넘었다<br>· 밸브 마모 5% 3/3 → 2/3, 10%·20%와 오탐 0은 그대로 | `lib/analytics/detectors/comp-sec-rise.ts`, `lib/analytics/episodes/compressor.ts` · `61060df`, `038cfd1` |
| `tank.static_leak` 판정 | §5.5 탱크 질량수지(Z 보정). §5.3 이름만 | · 정지 보유 구간(유입·유출 없음, 4 h 이상)마다 온도 보정 질량의 Theil–Sen 기울기를 구하고, 최근 6개 구간을 가중 중앙값(가중치 = 1/CI 반폭²)으로 결합해 누설률을 낸다.<br>· 상태식 기본값은 NIST Lemmon–Huber–Leachman 2008이다(Abel–Noble은 설정으로 선택).<br>· 기준 구간(가장 이른 12개, 최소 6개)의 손실 중앙값을 편향으로 빼되 ±3 × √(π/2)·σ/√n기준까지만 뺀다.<br>· 잡음 σ = max(MAD σ, 기준 구간 CI 반폭 중앙값 ÷ 1.96, 0.02 kg/일).<br>· **판정값 = 최근 가중 중앙값 − 기준 중앙값**이므로 표준오차 **SE = √(π/2)·σ·√(1/n_eff최근 + 1/n기준)** (가중 중앙값 비효율 √(π/2) ≈ 1.2533, n_eff = (Σw)²/Σw²).<br>· 유의 = 판정값 > 3 × SE 이고 CI 하한 > 0. CI 반폭 = max(1.96 × SE, 최근 구간 부트스트랩 반폭). safety·4는 CI 하한 > 0.5 kg/일일 때만 | · Abel–Noble의 온도 편향이 일교차 정지 보유에서 약 0.03 kg/일의 가짜 손실을 만들었다<br>· MAD만 쓰면 보유 구간이 적을 때 σ가 작게 잡혔다<br>· 예전 σ/√n최근은 기준 12·최근 6구간에서 실제 SE의 0.65배라 명목 3σ가 한쪽 약 2σ(2.5%) 검정이었다. 누설 0 합성 정지 구간 1000회 유의 판정 비율 **2.1% → 0.8%**, sim:eval 오탐 **198 → 14건**(정밀도 0.066 → 0.533)<br>· `safetyKgPerDay` 0.5는 근거 문헌이 없는 추정 기본값이다 | `lib/analytics/detectors/tank-static-leak{,-checks}.ts`, `lib/analytics/episodes/tank-hold.ts` · `61060df`, `038cfd1` |
| `pv.soiling_rate` 맑은 날·복원 | §5.3 이름만. 데이터 계약 초안 `rainfall_daily`(오염 리셋 판정 1 mm/일 이상) | · 맑은 날 판정: 일사 비율 0.8, 일중 변동 상한 1.3에 이웃 날 변동성 분위수 0.2를 더했다.<br>· 복원 시점: 세척 기록(조치, 또는 asset_event note의 '세척'·'clean')이나 맑은 날 PI 1.5% 이상 급상승.<br>· finding은 사이트 단위이고, 심각도는 누적 손실 2% → 2, 4% → 3(성능 카테고리, 3 상한) | · 고정 변동 상한만으로는 시뮬레이터 기상에서 맑은 날이 거의 없어 1년 내내 판정 불능이었다 → 0.05%/일 3/3<br>· 강수량 메트릭이 카탈로그에 없어 강우 대신 PI 급상승을 쓴다 | `lib/analytics/detectors/pv-soiling-{rate,days,checks}.ts` · `61060df`, `038cfd1` |
| `ess.resistance_growth` 계단·SOC 범위 | §5.3 이름만 | · `ess.current_step@1`: 이웃 두 샘플의 전류 차가 minStepC 이상인 깨끗한 계단에서 R_step = ΔV/ΔI.<br>· SOC 범위 30~70% → **10~90%**. bin: SOC 10% × 셀온도 5 °C.<br>· 가장 최근 샘플 주기와 같은 주기의 계단끼리만 비교하고 `R_{주기}s`로 표기한다 | · SIM-A 충방전 계단이 SOC 끝단에서 생겨 30~70%에서는 판정 불능이었다<br>· R_step에는 샘플 간격 동안의 분극이 섞여 주기에 따라 값이 달라진다 | `lib/analytics/detectors/ess-resistance-growth.ts`, `lib/analytics/episodes/ess-steps.ts` · `61060df`, `038cfd1` |
| `inv.thermal_derating` 반복 저감 | §5.3 이름만 | · 5분 버킷마다 동종 kW/kWp 중앙값보다 5% 이상 낮고, 방열판 ≥ 저감 시작 온도(명판, 없으면 70 °C) − 5 °C이며, 출력제한(99.5% 미만)이 아니면 저감 버킷이다.<br>· 최근 30일 손실률 1% → 2, 3% → 3.<br>· 손실률이 그보다 작아도 동종 대비 저감이 6시간(`sustainedDerateHours`) 이상이면 severity 2 | 냉각팬 고장은 더운 날에만 저감이 보여 월 손실률이 작다(0.73% < 1%) → 추가 뒤 냉각팬 고장 9/9, 오탐 0 | `lib/analytics/detectors/inv-thermal-derating.ts`, `lib/analytics/episodes/inverter-thermal.ts` · `61060df`, `038cfd1` |
| `fc.blower_wear` 입력 | §5.5 블로워 P ∝ Q³ | · 새 추출기 `fc.blower_run@1`(블로워 전력·공기 유량·외기 온도·형제 스택 운전시간). 비전력 = 전력 ÷ 유량.<br>· bin: 유량 100 kg/h × 외기 5 °C. bin 안 유량 차이는 친화 법칙(P/Q ∝ Q², 지수 2)으로 보정한다.<br>· 필터 교체는 asset_event(maintenance·replacement, note에 '필터'·'filter')로 인식한다 | `fc.steady_run` 에피소드에 블로워 유량·외기 온도가 없다 | `lib/analytics/detectors/fc-blower-wear.ts`, `lib/analytics/episodes/fc-blower.ts` · `61060df` |
| 판별 체크 입력 연결 (P3 후속) | §4.1 원인 판별 체크 | · `tank.static_leak` **뱅크 교차 확인**(`peer_pressure`): 같은 정지 구간에서 같은 뱅크 다른 용기(없으면 압축기 토출) 압력 기울기와 이 용기 압력 기울기의 차이를 이 용기 질량으로 환산한다. 이 용기에만 있는 손실 비율 ≥ 0.5면 지지(누설), ≤ 0.2면 반박(공용 소비·압력 기준 이동). 예전 `pressure_drift`(센서 드리프트) 체크를 대체한다.<br>· `fc.blower_wear` **에어필터 막힘**(`air_filter`): "기준 기간 이전 교체"만 보던 규칙을 창 안(상승 이후 포함) 교체까지로 넓혔다. 회복률 계산(`filter_events`)은 그대로다.<br>· `el.sec_rise` **퍼지 횟수**(`purge_count`): 로더가 전해조 설비(또는 스택)의 `purge.count` 누적 카운터 1시간 롤업을 KST 일 증가분으로 바꿔 넣는다 | · 정지 중에는 용기별 차단밸브가 닫혀 누설 용기만 압력이 떨어진다. 온도 보정을 하지 않은 원 압력 기울기끼리 빼면 뱅크가 함께 겪는 야간 냉각이 상쇄된다(보정한 손실률과 원 압력 기울기를 섞어 비교하면 대조 용기도 0.62 kg/일 손실로 보였다)<br>· 데모 SIM-B: 교차 확인 지지(이 용기 몫 1.021 kg/일 = 결합 누설률의 98.8%), 필터 교체(2026-09-05) 회복 28.56%로 지지<br>· 퍼지 체크는 카탈로그에 전해조 퍼지 카운터 포인트가 없어 데모 DB에서는 여전히 데이터없음이다(§13.8) | `lib/analytics/detectors/tank-peer-pressure.ts`, `lib/analysis/tank-holds.ts`, `lib/analysis/aux-inputs.ts`, `lib/analytics/pipeline/load-plans.ts` |
| `h2chain.mass_balance_gap` 판정 | §3 체인 원장 물질수지 잔차 감시 | · 사이트 단위. 최근 7일 잔차율 중앙값의 절댓값 > 2% 이고, 기준 14일로 표준화한 일 잔차율 CUSUM(같은 부호 방향)이 경보일 때 finding.<br>· CUSUM은 kg이 아니라 잔차율 %로 돌리고, 음의 잔차(생산 과소 계량)도 잡는다.<br>· 심각도 2. `tank.static_leak` 교차 확인이 '지지'면 3 | 생산량 변동의 영향을 줄이기 위해 잔차율을 쓴다. 안전 판단은 `tank.static_leak`와 현장 안전설비 몫이다 | `lib/analytics/detectors/h2chain-mass-balance.ts`, `lib/analytics/pipeline/site-ledger.ts` · `61060df`, `0968373` |

### 13.4 탐지기 기본 파라미터 (코드 `defaultParams`)

판정에 직접 영향을 주는 값만 옮겼다. 전체 파라미터의 min·max·설명은 각 탐지기의 `paramSchema`와 `/settings/detectors` 화면에 있다. 모든 탐지기의 버전은 `@1`이다. "기준 표본"은 bin별로 가장 이른 표본이고, 간격 상한을 넘는 bin은 결합에서 뺀다.

| 탐지기 | 고장모드 · 카테고리 | 기간 · 표본 | 조건 bin | 심각도 기준 | 그 밖의 핵심값 |
|---|---|---|---|---|---|
| `dq.gap_flatline` | `dq.data_gap_flatline` · data_quality | 완결성 < 0.95 또는 결측 합계 ≥ 2 h | — | 2 고정 | 고착 ≥ 6 h(일사량은 metric_def 2 h), 근거 포인트 10개 |
| `ess.capacity_fade` | `ess.capacity_fade` · degradation | 최근 21일, 최근 합계 ≥ 15, bin당 ≥ 3, 기준 표본 bin당 5개(간격 ≤ 120일), 완결성 ≥ 0.95, 부트스트랩 1,000회 | C-rate 0.05C × 셀온도 5 °C (휴지 앵커는 방향 × 셀온도) | CI 상한 < 0이고 −3% → 2, −5% → 3, −10% → 4 | 휴지 앵커: 휴지 30분, ΔSOC ≥ 25%p, SOC 1σ 1%p, 전류 적분 0.5%, 쌍 ≤ 36 h, 덮음 ≥ 0.98 · SOH 목표 80%(외삽 최소 60일) · CUSUM k 0.5, h 5, σ 하한 0.5% |
| `ess.cell_imbalance` | `ess.cell_imbalance` · degradation | 기준 20세션(최소 5), 최근 30일(최소 5), 추세 60일(최소 10일), 완결성 ≥ 0.9 | 측정 시점 충전 종료(`charge_end`) | 편차 증가 ≥ 20 mV이고 증가 추세면 2, ≥ 40 mV이거나 동종 수정 z > 3.5면 3 | 최소 동종 랙 2대, MAD 하한 2 mV |
| `pv.inverter_peer` | `pv.inverter_underperformance` · performance | 최근 7일 중 5일 이상, 동종 ≥ 3대, 완결성 ≥ 0.9 | 사이트 안 동종 인버터 | 수정 z < −3.5 → 2, 편차 ≤ −10% → 3 | MAD 하한 비율 0.003 |
| `el.voltage_rise` | `el.stack_voltage_degradation` · degradation | break-in 1,000 h 제외, bin당 ≥ 5, 합계 ≥ 15, 운전시간 범위 ≥ 100 h, 완결성 ≥ 0.9 | 전류밀도 보정 `reference_slope`, 온도 bin + bin 안 온도 회귀 | CI 하한 > 0이고 10 µV/h 초과 → 2, 20 → 3, 40 → 4 | 변화점 이후 ≥ 300 h, CUSUM k 0.5, h 5, σ 하한 0.5 mV |
| `fc.voltage_decay` | `fc.stack_voltage_decay` · degradation | break-in 500 h 제외, 나머지는 위와 같음 | 전류밀도 보정·온도 회귀 끔(온도 bin만), `v_cell_at_jref` | 위와 같음(10 · 20 · 40 µV/h) | 블로워 전력 증가 체크 10%, 운전 온도 변화 체크 3 °C |
| `el.sec_rise` | `el.system_efficiency_loss` · performance | 최근 30일, 기준 표본 bin당 10개(≤ 120일), bin당 ≥ 5, 합계 ≥ 15, break-in 1,000 h, 구간 생산량 ≥ 0.5 kg, 완결성 ≥ 0.9 | AC 전력 50 kW × 스택 온도 5 °C (`current_density`면 0.1 A/cm²) | CI 하한 > 0이고 +3% → 2, +5% → 3, +10% → 4 | 정류기·패러데이 효율 저하 1%p, 스택 전압 설명 비율 0.5, 부분부하 0.4·비중 증가 0.2, 퍼지 증가 30% |
| `h2chain.mass_balance_gap` | `h2chain.mass_balance_gap` · performance | 최근 7일(유효 ≥ 5일), 기준 14일(유효 ≥ 7일), 완결성 ≥ 0.9 | 사이트 일 원장 | 잔차율 2% 초과 + CUSUM 경보 → 2, 누설 교차 '지지'면 3 | CUSUM k 0.5, h 4, σ 하한 0.5%p · 유량계 비율 변화 2% · 상관 0.6(30일) · 누설 설명 비율 0.3 · 결측일 2 |
| `tank.static_leak` | `h2.storage_leak` · safety | 정지 보유 ≥ 4 h·샘플 ≥ 12·완결성 ≥ 0.8, 기준 12구간(최소 6), 최근 6구간(최소 4), 최근 30일 | 용기별 | CI 하한 > 0.5 kg/일 → safety 4, 유의하지만 그 미만 → performance 3 | 유의 배수 3σ, 편향 보정 한도 3σ, 잡음 σ 하한 0.02 kg/일 · 상태식 `lemmon2008` · 하류 압력 상승 1 bar, 온도 상관 0.6 |
| `comp.sec_rise` | `comp.efficiency_loss` · performance | 최근 30일, 기준 표본 bin당 10개(≤ 120일), bin당 ≥ 5, 합계 ≥ 15, 이송량 ≥ 5 kg, 완결성 ≥ 0.8 | 압력비 2 × 흡입(외기) 온도 5 °C | CI 하한 > 0이고 +5% → 2, +10% → 3, +20% → 4 | 토출 온도 상승 5 °C, 누설 감지 압력 상승 0.2 bar·주의 0.5 bar, 진동 증가 20%, 외기 편중 5 °C |
| `fc.blower_wear` | `fc.blower_wear` · degradation | 최근 30일, 기준 표본 bin당 10개(≤ 120일), bin당 ≥ 5, 합계 ≥ 15, 완결성 ≥ 0.8 | 공기 유량 100 kg/h × 외기 5 °C, 친화 지수 2 | CI 하한 > 0이고 +10% → 2, +20% → 3, +35% → 4 | 필터 교체 전후 14일·회복 5%, 외기 편중 5 °C, 스택 전압 감쇠 5 mV |
| `pv.soiling_rate` | `pv.soiling` · performance | 무세척 구간 ≥ 14일·맑은 날 ≥ 6일, 인버터 완결성 ≥ 0.9, 유효 인버터 ≥ 50% | 맑은 날: 일사 비율 0.8, 변동 상한 1.3, 변동 분위 0.2, 청천 상한 앞뒤 15일 | 기울기 CI < 0이고 누적 손실 2% → 2, 4% → 3 | 온도계수 γ −0.0035 /°C(명판 우선), 복원 급상승 1.5%(맑은 날 2일 비교), 사이트 전체 비율 0.75, GHI/POA 비율 변화 3%, 세척비 3,000,000원 |
| `ess.resistance_growth` | `ess.resistance_growth` · degradation | 최근 30일, 기준 표본 bin당 10개(≤ 120일), bin당 ≥ 5, 합계 ≥ 15 | SOC 10~90%·bin 10% × 셀온도 5 °C, 최소 계단 0.1C | CI 하한 > 0이고 +20% → 2, +40% → 3, +60% → 4 | 저온 편중 3 °C, 셀 편차 증가 10 mV, 용량 감소 동반 3% |
| `inv.thermal_derating` | `pv.inverter_thermal_derating` · performance | 최근 30일, 동종 ≥ 3대, 비교 최소 출력 0.3 kW/kWp, 최근 저감 시간 합계 ≥ 3 h·저감 일수 ≥ 3일 | 외기 bin 5 °C, bin별 기준 5일 | 손실률 1% → 2, 3% → 3, 반복 저감 ≥ 6 h → 2 | 동종 대비 5% 낮음, 저감 시작 70 °C(명판 우선) − 여유 5 °C, 고온 외기 35 °C, 동종 동시 고온 0.75 |

### 13.5 사이트 에너지·수소 체인 원장 (P3)

| 항목 | 설계 원문 요지 | 실제 구현 | 이유 · 한계 | 관련 파일 · 커밋 |
|---|---|---|---|---|
| 저장 테이블 | §5.2 `site_energy_daily`: flows_kwh, h2_kg(produced·stored_delta·fc_consumed·vented_est·residual), 전해조 계통전력 비율, SEC, P2P 효율, alloc_version | PK(site_id, day KST). 설계 컬럼에 더해 `energy_kwh`(노드별 합계, NOT NULL), `renewable_share`, `fc_kg_per_mwh`, `pv_loss_kwh`, `dq`, `calc_version`, `run_id`(NOT NULL, `analysis_run` FK), `computed_at`이 있다. 분석 실행이 `m_1h`만 읽어 계산하고 겹침 구간은 다시 계산해 upsert한다 | 기간 합 P2P에 노드별 합계가 필요하다. `run_id` FK 때문에 `analysis_run` 행만 따로 지울 수 없다 | `db/migrations/20260915090000000_om-site-energy-daily.sql` · `8a5c4d4` |
| 에너지 흐름 할당 `pool_hourly@1` | §3 PV → ESS/전해조 → 연료전지를 일 단위로 닫음. §9 할당 근사·alloc_version 표시 | 1) 매시 공급 {pv(인버터 `ac.power` 양수 합), ess_discharge(PCS `ac.power`, 방전 +), fc(`fc.ac.power`), grid_import(계량기 `ac.power`, 송전 + / 수전 −)}을 한 풀로 모은다.<br>2) 수요는 {site_aux, ess_charge, electrolyzer, compressor, grid_export}.<br>3) 계측 불일치 = 공급 합 − 계측 수요 합. 보조부하 계량이 없으면(`siteAuxKw` null) 양의 불일치를 보조부하로 보고, 추정값이 있으면 unmetered 수요로 둔다. 음의 불일치는 항상 unmetered 공급이다.<br>4) 흐름 from→to = 공급 × 수요 ÷ 풀 합계로 비례 할당해 하루 동안 더한다. 전력 행이 하나도 없는 시간은 풀에서 뺀다 | 한계: "한 시간 안의 전력은 섞인다"는 회계 가정이고 실제 전기적 경로가 아니다. 시간 평균을 쓰므로 한 시간 안에서 충전·방전이나 수전·송전이 번갈아 일어나면 순값만 남는다. ESS 방전은 PV로 충전한 전력으로 가정한다. 청정수소 인증 공식 산정이 아니다(화면에 명시) | `lib/analytics/ledger/allocation.ts`, `lib/chain/labels.ts` · `3101de1`, `8a5c4d4`, `11e04a2` |
| 전해조 전력 기준 | §3 전해조 kWh/kg, 계통전력 비율 | 흐름 할당은 정류기 AC 입력(없으면 전해조 설비 전체 AC)을 쓴다. SEC·P2P 분자는 BoP를 포함한 설비 전체 AC(없으면 정류기 입력)를 쓴다. 전해조 BoP, 인버터 야간 소비, 연료전지 대기 소비는 site_aux 계측분으로 넣는다 | 기존 KPI `elz.sec`가 설비 전체 기준이라 맞췄다 | `lib/analytics/ledger/allocation.ts` · `3101de1` |
| 수소 원장 `ledger@2` | §5.2 h2_kg: produced·stored_delta·fc_consumed·vented_est·residual | · produced: 전해조 적산계 `h2.mass.total` 하루 증가량(`meter_total`) 우선. 적산계가 없거나 경계 행이 없거나 값이 줄면 `h2.flow.mass` 적산(`meter`), 유량계도 없으면 셀 수 × 전류 × η_F × 3.7608e-5 kg/(A·h)(`faraday_estimate`, η_F 기본 1).<br>· stored_delta: 용기마다 끝·시작 P·T의 실기체 질량 차 합. 경계 시간이 정지 시간이면 P·T 시간 평균.<br>· vented_est = 퍼지 횟수 × `kgPerPurge` + `dryerLossFraction` × produced. 두 값의 기본은 0(추정 안 함).<br>· residual_pct = residual ÷ max(produced, fc_consumed, 1 kg) × 100 | · 5분 순시 유량의 시간 평균은 기동·정지가 표본 사이에 걸릴 때마다 틀려, 건강한 사이트 일 잔차율 p95가 2.083% → 적산계 우선 뒤 0.297%<br>· 배출 기본값 0: 유량계가 건조기 뒤, 연료전지 계량이 퍼지 전이면 이미 계량에 들어 있어 두 번 빼게 된다<br>· 한계: 유량계 행이 빠진 시간은 0으로 더해진다(`dq.h2.completeness`를 먼저 본다). 탱크 압력은 절대압으로 본다 | `lib/analytics/ledger/hydrogen.ts`, `lib/analytics/ledger/params.ts` · `3101de1`, `038cfd1` |
| PV 미활용 원인 분해 | §8 P3 산출물 "PV 미활용 원인 분해"(세부 규칙 없음) | 기대 발전 = Σ POA/1000 × kWp × PR_ref × (1 + γ(T_mod − 25)). 인버터·시간마다 차이(기대 − 실제)를 **outage → ess_full → curtailment → clipping → derating → soiling_est → unexplained** 순으로 나눈다. 버킷마다 상한만큼만 가져가고 나머지를 다음 버킷에 넘긴다(clipping 상한 = 기대 − 정격, derating 상한 = 동종 중앙값 × kWp − 실제, soiling 상한 = 손실률 × 기대). 합계 = 기대 − 실제가 반올림 뒤에도 성립하고, 실제가 기대보다 크면 unexplained가 음수다 | · ess_full(출력제한 + ESS SOC ≥ 90%)을 curtailment 뒤에 두면 늘 0이 된다<br>· 트립된 인버터는 출력제한과 관계없이 발전이 없어 outage를 맨 앞에 둔다<br>· 한계: 시간 해상도라 한 시간 일부만 트립·클리핑돼도 그 시간 전체를 그 조건으로 본다. 출력제한 신호 없이 송전 한도로 깎인 손실은 unexplained에 남는다 | `lib/analytics/ledger/pv-loss.ts`, `lib/analytics/ledger/pr-reference.ts` · `3101de1` |
| 수소 상태식·상수 | §5.5 탱크 질량수지 Z 보정 | 원장·누설 탐지기·전해조 비에너지가 `detectors/hydrogen-eos.ts` 한 곳의 정의를 쓴다.<br>· 기본: NIST Lemmon–Huber–Leachman 2008 압축계수 Z(T, P)(검증점 300 K·10 MPa → 1.05985282). 원장 표기 `lemmon2008@1`.<br>· Abel–Noble(선택): ρ = P / (R_s·T + b·P), R_s = R/M = 8.314462618 ÷ 2.01588e-3 ≈ **4124.48 J/(kg·K)**, b = **7.691e-3 m³/kg**(Chenoweth 1983, Sandia HyRAM 기본값).<br>· 패러데이 상수 96,485.33212 C/mol, 셀 1개·1 A·1 h 이론 수소 3.7608e-5 kg | · Abel–Noble은 고압에서 NIST 대비 약 ±0.5%(100 bar·0 °C −0.45%, 450 bar·40 °C +0.53%)이고 온도 의존도가 달라 정지 보유에 가짜 손실을 남겼다<br>· 처음에는 원장(4124.48, 7.691e-3)과 탐지기(4124.2, 7.69e-3)의 상수가 달라 하나로 통일했다<br>· 시뮬레이터 참값은 온도 의존 비리얼식(NIST 대비 ±0.13% 이내)이다 | `lib/analytics/detectors/hydrogen-eos.ts`, `lib/sim/models/h2-eos.ts` · `0968373`, `038cfd1`, `f7f3491` |
| 화면 경고 임계 | §9 completeness·불확도 표시 | 원장 품질 경고: 원천 완결성 90% 미만인 날, 계측 불일치율(unmetered kWh ÷ 풀 kWh) 3% 초과. 체인 섹션에 할당 가정과 청정수소 인증 공식 산정이 아니라는 문구를 표시한다 | 추정값이다. 개발 DB 데모 3사이트 120일의 기간 불일치율 약 0.1%, 일 최대 1.5%를 보고 정했다 | `lib/chain/limits.ts`, `components/sites/chain-section.tsx` · `11e04a2` |

### 13.6 탐지 준비도 규칙 (P3)

설계(§4.1)는 "자산 × 고장모드마다 필요한 메트릭 충족 여부와, 이 메트릭을 확보하면 풀리는 고장모드 수"였다. 구현 규칙은 아래와 같다. 탐지기별 필수 메트릭·주기·이력 목록은 [데이터 계약 초안 부록 A](data-contract-draft.md)에 있다.

| 규칙 | 구현 | 관련 파일 |
|---|---|---|
| 요구 조건 원천 | 탐지기 레지스트리 `requires`: 설비 종류(`assetClass`), 필수 메트릭(`metrics`, 판별 체크에만 쓰는 보조 메트릭은 제외), 샘플 주기 상한(`minPeriodS`, 포인트 `period_s`가 이 값 이하여야 함, null이면 무관), 최소 이력(`minHistoryDays`). 확보 순위 가중치용 대표 심각도는 카테고리로 정한다: safety 4, degradation·performance·availability 3, data_quality 2 | `lib/analytics/detectors/*.ts`, `lib/analytics/readiness/registry.ts` |
| 셀 상태 | · n/a: 설비 종류가 해당 없음<br>· 없음(missing): 필수 메트릭 포인트가 하나라도 없음<br>· 부분(partial): 메트릭은 모두 있으나 완결성 < 0.9(데이터 없음은 0으로 봄), 주기 > 상한, 이력 < 최소 이력 중 하나 이상<br>· 준비(ready): 그 밖<br>같은 메트릭 포인트가 여럿(한정자)이면 완결성 → 주기 → 이력 순으로 가장 좋은 포인트를 쓴다. 셀 이력은 쓰는 포인트 이력의 최솟값이다. 주기 상한은 그 탐지기의 필수 메트릭 전부에 같이 적용한다 | `lib/analytics/readiness/matrix.ts` |
| 행 구성 | · 첫 행 '(사이트 전체)': 사이트 단위 탐지기(물질수지·오염)만 판정한다. 요구 설비 종류 설비들의 포인트를 합쳐 보고, 그런 설비가 사이트에 없으면 n/a다.<br>· 설비 행: 대상 설비 종류가 같은 탐지기만 판정한다. 자기 포인트에 분석이 합쳐 쓰는 상위·형제·사이트 설비 포인트(에피소드 입력 규칙 + 인버터의 기상 설비 외기 온도)를 더한다.<br>· `dq.gap_flatline`은 포인트가 있는 모든 설비에 적용한다.<br>· 한정자 포인트(`valve.open#inlet`)는 메트릭 키만으로 요구 조건과 맞춘다 | `lib/analytics/readiness/site.ts`, `lib/analytics/pipeline/{sources,targets}.ts` |
| 수집 통계 | 창은 최근 30일이다. 완결성 = 창 안 good 샘플 ÷ 기대 샘플이고, 기대 샘플은 max(첫 데이터, 창 시작)부터 지금까지로 센다. 창에 샘플이 없으면 "데이터 없음"이다. 이력 = 지금 − 첫 1시간 롤업(일, 내림). 포인트 주기가 없으면 창의 샘플 밀도로 추정한다. 요건 정의상 최소 이력은 기준선 재설정 이후 기간이지만, 화면은 첫 샘플부터 센다 | `lib/analytics/readiness/site.ts`, `lib/data/readiness.ts` |
| 확보 순위 | unlocks(그 메트릭 하나만 없어서 없음인 셀 수) → severityWeight(그 셀들의 심각도 합) → blockedCells(그 메트릭이 누락 목록에 있는 셀 수) → 메트릭 키 순 | `lib/analytics/readiness/ranking.ts` |
| 화면·CSV | `/data/readiness`. 상태는 색만으로 구분하지 않고 아이콘·글자·툴팁을 함께 준다. CSV `/api/readiness.csv`는 기본이 매트릭스, `table=acquisition`이면 확보 순위다. UTF-8 BOM, 비로그인은 401 | `app/(console)/data/readiness/page.tsx`, `app/api/readiness.csv/route.ts` · `6ede05b` |

### 13.7 sim:eval 게이트와 최신 수치

`lib/analytics/scorecard.json`(생성 2026-09-15, 전체 게이트 통과) 기준이다.

- **평가 조건:** 메모리 모드, 2025-10-01부터 365일, 시드 101·202·303, 고장 시작 120일째. P2 스윕과 P3 12순번을 합쳐 잡 84개. 캐시 없이 처음 돌리면 약 22분, 준비 결과 캐시(`--cache`)를 재사용한 이번 실행은 455초.
- **CI 축소 조합:** `--runs 3,4,5,6,8,9,10,11,17`(잡 51개). 게이트 38개 판정이 모두 전체 실행과 같았다(오탐 0.0041, 최소 탐지 크기 0.15). 최소 탐지 크기 게이트를 판정하려면 0.15 kg/일 주입이 필요해 순번 8 대신 순번 6을 넣었다.
- **게이트:** 38개(P2 19 + P3 19).
- **오탐 단위:** 건/자산·월(대조군 구간 포함).

| # | 구분 | 게이트 | 기준 | 최신 값 |
|---|---|---|---|---|
| 1 | P2 | `ess.capacity_fade.recall_5pct` SIM-A(태양광+ESS) 5% 이상 재현율 (주입 9건) | ≥ 0.9 | 1 |
| 2 | P2 | `ess.capacity_fade.mae_5pct` SIM-A 5% 이상 크기 MAE [%p] | ≤ 1 | 0.0698 |
| 3 | P2 | `ess.capacity_fade.delay_5pct` SIM-A 5% 이상 탐지 지연 중앙값 [일] | ≤ 21 | 18 |
| 4 | P2 | `ess.capacity_fade.integrated_recall_5pct` SIM-B(연계형 부분 사이클) 5% 이상 재현율 (주입 9건) | ≥ 0.8 | 1 |
| 5 | P2 | `ess.capacity_fade.integrated_delay_5pct` SIM-B 5% 이상 탐지 지연 중앙값 [일] | ≤ 45 | 18 |
| 6 | P2 | `ess.capacity_fade.summer_insufficient_run_days` 여름(6~8월) 연속 판정 불능 최장 일수 (전 사이트·랙) | < 60 | 0 |
| 7 | P2 | `ess.capacity_fade.soc_limit_control_ok_checks` SOC 상한 변경 대조군, 변경 7일 뒤 판정 ok 점검 수 (랙 6대 중 최소) | ≥ 1 | 10 |
| 8 | P2 | `ess.capacity_fade.soc_limit_control_fp` SOC 상한 변경 대조군, 변경 이후 finding 수 | ≤ 0 | 0 |
| 9 | P2 | `ess.capacity_fade.fp_per_asset_month` 오탐 (2,457.8 자산·월) | ≤ 0.1 | 0 |
| 10 | P2 | `ess.cell_imbalance.fp_per_asset_month` 오탐 (2,457.8) | ≤ 0.1 | 0 |
| 11 | P2 | `pv.inverter_peer.fp_per_asset_month` 오탐 (3,719.8) | ≤ 0.1 | 0 |
| 12 | P2 | `el.voltage_rise.fp_per_asset_month` 오탐 (631) | ≤ 0.1 | 0 |
| 13 | P2 | `fc.voltage_decay.fp_per_asset_month` 오탐 (631) | ≤ 0.1 | 0 |
| 14 | P2 | `dq.gap_flatline.fp_per_asset_month` 오탐 (17,470) | ≤ 0.1 | 0 |
| 15 | P3 | `el.sec_rise.fp_per_asset_month` 오탐 (631) | ≤ 0.1 | 0 |
| 16 | P3 | `h2chain.mass_balance_gap.fp_per_asset_month` 오탐 (631) | ≤ 0.1 | 0.0048 |
| 17 | P3 | `tank.static_leak.fp_per_asset_month` 오탐 (2,524.2, 정밀도 0.533) — 안전 카테고리를 낼 수 있어 다른 탐지기보다 엄격 | **≤ 0.02** | 0.0055 |
| 18 | P3 | `comp.sec_rise.fp_per_asset_month` 오탐 (631) | ≤ 0.1 | 0 |
| 19 | P3 | `fc.blower_wear.fp_per_asset_month` 오탐 (631) | ≤ 0.1 | 0 |
| 20 | P3 | `pv.soiling_rate.fp_per_asset_month` 오탐 (930) | ≤ 0.1 | 0 |
| 21 | P3 | `ess.resistance_growth.fp_per_asset_month` 오탐 (2,457.8) | ≤ 0.1 | 0.0122 |
| 22 | P3 | `inv.thermal_derating.fp_per_asset_month` 오탐 (3,719.8) | ≤ 0.1 | 0 |
| 23 | P2 | `el.voltage_rise.recall_20uvh` 20 µV/h 이상 재현율 (주입 6건) | ≥ 0.9 | 1 |
| 24 | P2 | `el.voltage_rise.rel_error_20uvh` 20 µV/h 이상 크기 상대오차 중앙값 | ≤ 0.1 | 0.003 |
| 25 | P2 | `fc.voltage_decay.rel_error_20uvh` 20 µV/h 이상 크기 상대오차 중앙값 (주입 6건) | ≤ 0.1 | 0.034 |
| 26 | P2 | `ess.cell_imbalance.recall_10mv` 월 10 mV 이상 재현율 (주입 6건) | ≥ 0.9 | 1 |
| 27 | P2 | `dq.gap_flatline.recall_6h` 6시간 이상 결측·고착 재현율 (주입 24건) | ≥ 0.9 | 1 |
| 28 | P3 | `h2chain.healthy_residual_median` 대조군 SIM-C 일별 물질수지 잔차율 절댓값 중앙값 [%] (2,190일) | < 1 | 0.101 |
| 29 | P3 | `h2chain.healthy_residual_p95` 같은 값의 95퍼센타일 [%] | < 2 | 0.297 |
| 30 | P3 | `tank.static_leak.min_detectable_kg_per_day` 재현율 0.9 이상인 최소 누설률 [kg/일] (측정값 0.15 + 스윕 한 단계 여유) | **≤ 0.2** | 0.15 |
| 31 | P3 | `pv.control_findings` PV 대조군(출력제어·흐린 주·비 오는 주) 구간의 PV 탐지기 finding 수 | ≤ 0 | 0 |
| 32 | P3 | `el.sec_rise.recall_5pct` 비에너지 5% 이상(정류기·패러데이·스택 경로) 재현율 (주입 18건) | ≥ 0.8 | 1 |
| 33 | P3 | `comp.sec_rise.recall_valve_10pct` 밸브 마모 10% 이상 재현율 (주입 6건) | ≥ 0.8 | 1 |
| 34 | P3 | `fc.blower_wear.recall_20pct` 블로워 비전력 +20% 이상(필터 막힘 20% 이상·마모 누적 20% 이상) 재현율 (주입 12건) | ≥ 0.8 | 1 |
| 35 | P3 | `pv.soiling_rate.recall_0_1pct_day` 오염 0.1%/일 이상 재현율 (주입 6건) | ≥ 0.8 | 1 |
| 36 | P3 | `ess.resistance_growth.recall_40pct` 내부저항 +40% 이상 재현율 (주입 3건) | ≥ 0.8 | 1 |
| 37 | P3 | `inv.thermal_derating.recall_fan_failure` 냉각팬 고장(겨울·봄·여름 시작) 재현율 (주입 9건) | ≥ 0.8 | 1 |
| 38 | P3 | `h2chain.mass_balance_gap.recall_drift_3pct` 유량계 드리프트 3%/월 이상 재현율 (주입 3건) | ≥ 0.8 | 1 |

탐지기별 요약(전체 스윕 기준)이다. 재현율에는 탐지 한계보다 작은 주입도 들어 있어 1보다 낮게 나온다. 최소 탐지 크기는 재현율 0.9 이상인 가장 작은 주입 크기다.

| 탐지기 | 단위 | TP | FP | FN | 재현율 | 정밀도 | 자산·월 | 오탐/자산·월 | 지연 중앙값(일) | 크기 MAE | 최소 탐지 크기 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ess.capacity_fade` | % | 24 | 0 | 6 | 0.8 | 1 | 2,457.8 | 0 | 19.5 | 0.079 | 3 |
| `ess.cell_imbalance` | mV/월 | 9 | 0 | 0 | 1 | 1 | 2,457.8 | 0 | 74 | — | 5 |
| `pv.inverter_peer` | %p | 6 | 0 | 6 | 0.5 | 1 | 3,719.8 | 0 | 5 | 0.065 | 2 |
| `el.voltage_rise` | µV/h | 9 | 0 | 3 | 0.75 | 1 | 631 | 0 | 37 | 0.104 | 10 |
| `fc.voltage_decay` | µV/h | 6 | 0 | 6 | 0.5 | 1 | 631 | 0 | 25.5 | 1.02 | 20 |
| `dq.gap_flatline` | h | 30 | 0 | 6 | 0.833 | 1 | 17,470 | 0 | 0.8 | — | 6 |
| `el.sec_rise` | % | 18 | 0 | 9 | 0.667 | 1 | 631 | 0 | 61 | 3.339 | 6 |
| `h2chain.mass_balance_gap` | %/월 | 9 | 3 | 0 | 1 | 0.75 | 631 | 0.0048 | 34 | — | 1 |
| `tank.static_leak` | kg/일 | 16 | 14 | 11 | 0.593 | 0.533 | 2,524.2 | 0.0055 | 5 | 0.034 | 0.15 |
| `comp.sec_rise` | % | 8 | 0 | 10 | 0.444 | 1 | 631 | 0 | 42 | 2.636 | 10 |
| `fc.blower_wear` | %/월 | 14 | 0 | 4 | 0.778 | 1 | 631 | 0 | 50.5 | 5.094 | 5 |
| `pv.soiling_rate` | %/일 | 9 | 0 | 3 | 0.75 | 1 | 930 | 0 | 45 | — | 0.05 |
| `ess.resistance_growth` | % | 10 | 30 | 2 | 0.833 | 0.25 | 2,457.8 | 0.0122 | 54.5 | 11.63 | 20 |
| `inv.thermal_derating` | 냉각 저하 배율 | 9 | 0 | 0 | 1 | 1 | 3,719.8 | 0 | 115 | — | 1 |

**참고 지표** (게이트 아님)
- **건강한 물질수지(SIM-C 2,190일):** 일 잔차율 절댓값 중앙값 0.101%, p90 0.248%, p95 0.297%, 최대 5.42%.
- **`el.sec_rise` 경로 판별 체크 지지 비율:** 전체 0.722(목표 0.7). 경로별(각 6건)로는 정류기 0.333, 패러데이 0.833, 스택 1.0.
- **누설과 물질수지:** 0.2 kg/일 이상 누설 주입 9건 중 물질수지 finding이 함께 나온 것은 0건(0). 0.2~0.5 kg/일 누설은 일 잔차율이 약 0.4~1.1%라 물질수지 임계 2%에 닿지 않는다(스윕 확장 전에는 주입 6건 중 3건이었는데, 그때 함께 나온 finding은 같은 순번의 다른 고장이 낸 것이다).
- **냉각팬 고장 탐지 지연:** 시작 120일째(겨울) 194·153·131일, 200일째(봄) 115·73·115일, 280일째(여름) 43·36·35일.
- **크기별 탐지:**
  - `tank.static_leak`: 0.005 kg/일 0/3, 0.01 0/3, 0.02 1/3(104일), 0.05 1/3(76일), 0.1 2/3(10.5일), 0.15 3/3(6일), 0.2 3/3(6일), 0.25·0.5 3/3(4일).
  - `el.sec_rise`: 3% 0/9, 6% 9/9, 10% 9/9.
  - `ess.capacity_fade`: 1% 0/6, 3% 이상 6/6.
  - `ess.cell_imbalance`: 월 5 mV 지연 133일, 10 mV 74일, 20 mV 43일.

§8 P3 완료 기준과의 대응

| §8 완료 기준 | 구현한 게이트 | 결과 |
|---|---|---|
| 신규 시나리오 게이트 편입·기존 회귀 없음 | P3 게이트 19개 추가, P2 게이트 19개 유지 | 38/38 통과. `el.voltage_rise` 20 µV/h 이상 상대오차는 0.038 → 0.003으로 좋아졌다 |
| 건강한 사이트 물질수지 잔차 < 1% | SIM-C 일 잔차율 절댓값 중앙값 < 1%, p95 < 2% | 0.101%, 0.297%. 일 최대는 5.42%라 "매일 1% 미만"은 아니다 |
| 탱크 미세누설 최소 탐지 크기 곡선 산출 | 0.005~0.5 kg/일 9단계 곡선, 재현율 0.9 이상 최소 크기 ≤ 0.2 | 0.15 kg/일 |
| 출력제어·흐린 주 대조군에서 PV finding 0건 | 출력제어·흐린 주·비 오는 주 구간의 PV 탐지기 finding 0 | 0건 |

### 13.8 알려진 한계·현장 적용 전 확인 사항

| 항목 | 내용 | 현장 적용 전 확인·조치 | 근거 |
|---|---|---|---|
| SOC 기반 용량 추정의 BMS 의존 | · 휴지 앵커·CC·SOC 변화 방식은 BMS SOC 재보정 품질에 의존한다.<br>· 시뮬레이터 SOC는 참값이라 재보정 오차가 없어 평가 결과가 실제보다 좋게 나온다.<br>· 용량 감소가 끝난 뒤 처음 나타난 bin은 그 감소를 보지 못한다.<br>· 용량 조치 효과 검증(`ess.capacity_ah`)은 충전 세션 방식(앵커 → CC → SOC)만 써서, 연계형 사이트에서는 데이터 부족으로 끝날 수 있다 | 파일럿 BMS의 휴지 OCV 재보정 동작과 SOC 점프 빈도를 확인한다. 정기 용량시험 결과를 조치로 기록한다 | `lib/analytics/detectors/ess-capacity-samples.ts`, `lib/analytics/verification/before-after.ts` |
| R_step의 샘플 주기 의존 | · R_step = ΔV/ΔI는 샘플 간격 동안의 분극을 포함해 주기에 따라 값이 달라진다. 같은 주기 계단끼리만 비교하므로 주기를 바꾸면 이전 계단은 비교에서 빠진다.<br>· 요구 주기 상한은 60초이고, 데이터 계약 초안의 DCIR용 권장은 2초 이하다.<br>· 시뮬레이터 배터리에는 RC 분극이 없어 60초 ΔV/ΔI에 OCV 변화가 조금 섞인다(+50% 주입이 1.60배로 보임).<br>· 크기 MAE 11.63%p. 오탐 0.0122는 인접 랙 용량 감소와 연동된다.<br>· 데모 랙은 적재 시작 시각에 따라 결과가 달랐다(메모리 모드: 14시 +28.4%, 15시 +17.0%로 finding 없음, 16시 +37.8%, 17시 finding 없음) | 랙 전류·전압 주기를 정하고 운영 중에는 바꾸지 않는다. 크기 해석은 추세·판별 체크와 함께 본다 | `lib/analytics/episodes/ess-steps.ts`, `lib/sim/models/` · `f7f3491`, `8a5c4d4` |
| 비례 할당 가정 | · `pool_hourly@1`은 회계 가정이다(13.5).<br>· PV가 전해조에 직접 연결됐거나 ESS를 계통으로 충전하는 구성에서는 흐름이 실제와 다르다.<br>· 적산계(`h2.mass.total`)가 없는 사이트는 유량 적산으로 돌아가 건강한 사이트 일 잔차율 p95가 약 2%가 된다 | 계량점 구성(정류기 입력·설비 전체·보조부하·계통 계량기 부호)을 확인한다. 청정수소 인증 공식 산정에 쓰지 않는다 | `lib/analytics/ledger/allocation.ts`, `lib/analytics/ledger/hydrogen.ts` |
| 시뮬레이터 튜닝 파라미터의 현장 오탐 위험 | 아래 기본값은 시뮬레이터 평가·데모에 맞춰 정하거나 바꿨다. 현장 데이터로는 검증하지 않았다.<br>· `pv.inverter_peer.madFloorRatio` 0.003<br>· `ess.capacity_fade.recentDays` 21·`minPerBin` 3<br>· `el.sec_rise.binBy` ac_power: 전류 설정값 운전 설비에는 맞지 않음<br>· `el.voltage_rise` reference_slope: 분극곡선 비선형과 계절에 따른 전류밀도 분포 이동이 겹치면 편향 가능<br>· `fc.voltage_decay` 기준 전류밀도 0.6 A/cm²·분극 기울기 0.2: 일반 PEMFC 값<br>· `comp.sec_rise.minMassKg` 5: 정상 이송량이 5 kg 미만인 소형 압축기는 조정 필요<br>· `pv.soiling_rate` 변동 상한 1.3·분위 0.2<br>· `inv.thermal_derating` 저감 시작 70 °C·반복 저감 6 h: 데모 냉각팬 저감 6.8 h로 경계 근처<br>· `tank.static_leak.safetyKgPerDay` 0.5: 추정<br>· 원장 경고 90%·3% | 파일럿에서 `detector_config`로 사이트별 값을 조정하고(근거에 버전·해시가 남음), 기각 사유 파레토(§8 P4)로 다시 정한다. 분극곡선·디레이팅 곡선·압축기 정격 같은 제조사 사양이 오면 기본값을 교체한다 | `lib/analytics/scorecard.json`(params_note), 각 탐지기 파일 |
| `tank.static_leak` 검정 크기 (정정 완료) | · 표준오차를 σ/√n최근에서 √(π/2)·σ·√(1/n_eff최근 + 1/n기준)으로 고쳤다(§13.3). 누설 0 합성 정지 구간 1000회 유의 판정 비율 2.1% → 0.8%, sim:eval 오탐 0.0784 → 0.0055건/자산·월(198 → 14건), 정밀도 0.066 → 0.533.<br>· 대가: 0.005~0.05 kg/일 작은 누설 재현율이 떨어져 최소 탐지 크기가 0.1 → 0.15 kg/일이 됐다(재현율 0.593). 탐지 지연 중앙값은 10.5 → 5일로 좋아졌다.<br>· 남는 차이(명목 0.135% vs 실측 0.8%)는 기준 12구간 MAD로 σ를 재는 표본오차다. 기준 구간 수를 늘리면 줄지만 준공 초기 기준 확보가 늦어진다.<br>· 안전 finding이 심각도 3으로 내려가면 배너에서 조용히 빠진다(전이 기록·알림 없음) | 심각도 하향 시 기록 방식을 정한다. 기준 구간 수(12)를 사이트별로 올릴지 파일럿에서 판단한다. 현장 누설 판단·운전 정지는 가스 검지기·안전설비·현장 안전책임자 몫이다. 이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않는다 | `lib/analytics/detectors/tank-static-leak.ts` · `ae72e31`, `73282b6` |
| 상태식·압력 기준 | · 분석은 탱크 압력을 절대압으로 본다. 게이지압이면 약 1 bar에 해당하는 질량이 일정하게 편향된다(차분에서는 대부분 상쇄).<br>· 시뮬레이터 PLC 재고 추정 `h2.inventory`는 300~450 bar에서 참값보다 1.0~1.9% 크다.<br>· 충전·방출 직후 가스 온도와 센서 온도 차이가 재고를 흔든다 | 압력 전송기의 게이지·절대 구분, 용기 내용적 명판, 온도 센서 위치(표면·가스)를 확인한다 | `lib/analytics/ledger/hydrogen.ts`, `lib/analytics/detectors/hydrogen-eos.ts` · `f7f3491` |
| 판별 체크 입력 (퍼지만 남음) | · `tank.static_leak` 압력 교차 확인과 `fc.blower_wear` 에어필터 막힘은 연결했다(§13.3). 데모 DB에서 각각 '지지'가 나온다.<br>· `el.sec_rise` 퍼지 횟수는 로더를 연결했지만 카탈로그에 전해조 퍼지 카운터 포인트가 없어(`purge.count`는 연료전지 FC1에만 있다) 데모 DB에서는 여전히 '데이터없음'이다. 전해조에 포인트를 추가하면 그 시점부터 값이 생긴다.<br>· 메모리 평가(`lib/sim/eval`)에는 교차 확인·퍼지 입력을 넣지 않았다. 두 체크는 판정(심각도·finding 수)에 영향이 없어 게이트에 쓰이지 않는다 | 전해조 퍼지 카운터를 데이터 계약에 넣을지 정하고, 넣으면 `metric_def`·포인트 매핑을 추가한다 | `lib/analysis/aux-inputs.ts`, `lib/analysis/tank-holds.ts`, `db/seed/templates-hydrogen.ts` |
| 짧은 기준 기간과 계절 bin 이동 | · 같은 조건 비교에서 여름 bin 기준이 고장 뒤에 생기면 효과를 작게 잡는다(블로워·압축기·내부저항).<br>· `el.sec_rise` 3% 상승 0/9, 크기 MAE 3.381, 정류기 경로 판별 체크 지지 비율 0.333.<br>· 평가 곡선에 단위가 섞였다: 압축기 씰 누설(bar/일, 0/9)이 % 곡선에, 블로워 "10" 구간에 마모 %/월과 막힘 %가 함께 있다 | 1년 이상 기준을 모으기 전에는 크기보다 방향·추세로 해석한다. 설비 교체·설정 변경은 `asset_event(resets_baseline)`로 기록한다 | `lib/analytics/scorecard.json` · `ae72e31` |
| 카탈로그에 없는 메트릭 | 일 강수량(오염 복원은 맑은 날 PI 급상승으로 대신), 압축기 흡입 가스 온도(외기 온도로 대신), 전해조 퍼지 카운터(`el.sec_rise` 퍼지 체크가 데이터없음) | 현장에서 받을 수 있으면 `metric_def`에 추가하고 탐지기 입력을 바꾼다 | `db/seed/catalog.ts`, `lib/analytics/episodes/compressor.ts` |
| 준비도 주기·기준 시각 | · 주기 상한을 탐지기의 필수 메트릭 전부에 같이 적용한다. 그래서 SIM-B 스택 탐지기 3개 셀은 온도·운전시간 포인트가 300초라 '부분'으로 나오지만 분석은 동작한다.<br>· 완결성은 '지금'부터 30일로 계산해, 수신이 멈춘 데모 데이터는 날이 지날수록 완결성이 떨어진다 | 주기 상한을 메트릭별로 나눌지 정한다 | `lib/analytics/readiness/matrix.ts`, `lib/data/readiness.ts` |
| 데이터 품질 평가 범위 | · 메모리 평가는 전송 계층 단절·백필·지연·시계 오차를 재현하지 않는다(DB E2E 모드 몫).<br>· 낮 시간에 0 근처로 고착된 일사계는 야간 제외 규칙 때문에 잡히지 않는다.<br>· 3시간 결측·고착은 12건 중 6건만 잡는다 | 파일럿 게이트웨이의 실제 단절·백필 패턴으로 다시 확인한다 | `lib/analytics/dq/summary.ts` · `8152a95` |
| 탐지 지연 | · 전해조 스택은 break-in 1,000 h 이후만 쓴다.<br>· 연료전지 10 µV/h 이하는 탐지하지 못한다.<br>· 냉각팬 고장은 겨울에 시작하면 여름까지 드러나지 않는다(131~194일) | 리포트의 "관찰 중"·판정 보류 표현을 유지한다 | `lib/analytics/scorecard.json` |
| 개발 의존성 취약점 | `npm audit`(2026-09-15)<br>· 운영 의존성: 0건<br>· 개발 의존성: 8건(high 5: brace-expansion·browserslist·flatted·js-yaml·minimatch / moderate 2: @humanfs/node·ajv / low 1: @babel/core)<br>· 모두 eslint·eslint-config-next·kysely-codegen을 거친 간접 의존성이고, 수정 버전은 있지만 적용하지 않았다. next는 0건이다 | 운영 전환 전에 lock 파일을 갱신하고 lint·typecheck·test·build를 다시 확인한다 | `package.json`, `package-lock.json` |

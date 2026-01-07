# ☀️ SolarAI - 태양광 발전소 통합 관제 및 예지보전 시스템

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Next.js](https://img.shields.io/badge/Next.js-15.1-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-AWS_RDS-336791)
![Vercel](https://img.shields.io/badge/Deployment-Vercel-black)

## 📖 프로젝트 개요

**SolarAI**는 다수의 태양광 발전소를 실시간으로 모니터링하고, AI 기반 분석을 통해 **고장 시점을 예측(Predictive Maintenance)**하여 **손실 비용을 최소화**하는 것을 목표로 하는 통합 관제 대시보드입니다.

단순한 데이터 시각화를 넘어, **실시간 발전 효율 계산, 예상 손실액 분석, 고장 예측 알림** 등 실제 현장에서 관리자가 필요로 하는 비즈니스 인사이트를 제공합니다.

## 🚀 핵심 기능 (Key Features)

### 1. 🌍 GIS 기반 실시간 통합 관제

- **카카오맵(Kakao Map API) 연동**: 전국에 흩어진 발전소 위치 시각화.
- **상태별 마커 시스템**: 정상(초록), 경고(노랑), 고장(빨강) 상태를 직관적으로 구분.
- **실시간 데이터 팝업**: 마커 클릭 없이도 **날씨, 고장 예측일, 시간당 손실금액**을 즉시 확인 가능.

### 2. 🔮 AI 예지 보전 (Predictive Maintenance)

- **고장 시점 예측**: 데이터 분석을 통해 "7일 후 고장 예상" 등의 구체적인 예측 정보 제공.
- **손실 비용 시각화**: 장비 고장 시 발생하는 **금전적 손실(예: -15,000원/h)**을 실시간 계산하여 표시.
- **우선 순위 점검 리스트**: 긴급하게 수리가 필요한 발전소를 자동으로 상단에 노출.

### 3. 📊 발전 효율 정밀 분석

- **동적 차트(Chart.js)**: 시간대별 발전량 추이를 시각적으로 분석.
- **실시간 효율 계산**: `발전량 / 설비용량` 공식을 서버 사이드에서 실시간 연산하여 정확한 효율 제공.
- **환경 변수 보정**: 날씨(맑음/흐림/비)에 따른 발전량 저하를 고장으로 오진하지 않도록 보정 로직 적용.

### 4. 💰 수익 관리 및 리포트

- **예상 수익 산출**: SMP(계통한계가격) 및 발전량을 기반으로 월별 예상 수익 자동 계산.
- **환경 기여도 분석**: 탄소 저감량(Ton), 설비 가동률 등 ESG 지표 제공.

---

## 🛠 기술 스택 (Tech Stack)

| 구분         | 기술                           | 설명                                               |
| :----------- | :----------------------------- | :------------------------------------------------- |
| **Frontend** | **Next.js 15 (App Router)**    | 서버 사이드 렌더링(SSR) 및 최신 라우팅 시스템 적용 |
|              | **TypeScript**                 | 정적 타입 지정을 통한 안정적인 데이터 처리         |
|              | **Tailwind CSS**               | 반응형 디자인 및 직관적인 UI 스타일링              |
|              | **Chart.js / React-Chartjs-2** | 데이터 시각화 및 동적 그래프 구현                  |
| **Backend**  | **Next.js API Routes**         | Serverless 환경의 API 엔드포인트 구축              |
|              | **PostgreSQL (AWS RDS)**       | 관계형 데이터베이스 구축 및 데이터 관리            |
|              | **pg (node-postgres)**         | 효율적인 DB 커넥션 풀링(Pooling) 관리              |
| **Infra**    | **Vercel**                     | CI/CD 자동화 및 프로덕션 배포                      |
| **API**      | **Kakao Map SDK**              | 지도 서비스 연동                                   |

---

## 🏗 시스템 아키텍처 및 DB 구조

### System Flow

1. **Client**: 사용자가 대시보드 접속.
2. **Next.js API**: DB에 쿼리를 전송하고, 실시간 발전량 및 효율을 계산(Business Logic).
3. **AWS RDS**: 태양광 발전 로그(`solar_logs`), 사이트 정보(`solar_sites`) 저장.
4. **Client**: 계산된 데이터를 받아 지도, 차트, 리스트로 렌더링.

### 주요 데이터베이스 로직

- **실시간성 보장**: 별도의 집계 테이블을 두지 않고, 조회 시점에 `gen`(발전량)과 `cons`(소비량)을 기반으로 `sales`(매전량), `eff`(효율), `loss`(손실액)을 역산하여 데이터 정합성 유지.

---

## 🔧 설치 및 실행 방법 (Installation)

1. **레포지토리 클론**
   ```bash
   git clone [https://github.com/your-username/solar-dashboard.git](https://github.com/your-username/solar-dashboard.git)
   cd solar-dashboard
   ```

// 배포 후 확인할 콘솔 경로와 "그 화면이 실제로 그려졌다"는 표시 문구 (scripts/deploy-check.ts). 순수 모듈.
// 표시 문구는 화면 본문에 서버가 그리는 글자다 — 200이어도 스트리밍 중 오류로 본문이 비면 걸린다.
// 문구에 <, >, & 를 넣지 않는다 (HTML에서 이스케이프돼 그대로 찾을 수 없다).

export interface RouteCheck {
  readonly label: string;
  readonly path: string;
  readonly marker: string;
}

export interface RouteIds {
  readonly siteCode: string | null;
  readonly findingId: string | null;
  readonly reportId: string | null;
}

const STATIC_ROUTES: readonly RouteCheck[] = [
  { label: '대시보드', path: '/', marker: '출근 후 5분 안에 할 일과 밤사이 변화 파악' },
  { label: '플릿', path: '/fleet', marker: '여러 사이트를 도메인별 건강 상태로 관망' },
  { label: '사이트', path: '/sites', marker: '사이트 맥락: 설비 트리, KPI, 타임라인, 에너지·수소 체인' },
  { label: '분석 데스크', path: '/desk', marker: '분석을 실행하고 발견사항' },
  { label: '코칭 리포트', path: '/reports', marker: '사이트별 리포트 초안을 만들고 검토·승인한 뒤 PDF로 출력' },
  { label: '조치 추적', path: '/actions', marker: '권고가 조치와 효과 검증으로 이어지는지 추적' },
  { label: '데이터', path: '/data', marker: '수집 상태·데이터 품질 관리, 데이터 계약 협의 지원' },
  { label: '데이터 품질', path: '/data/quality', marker: '포인트별 품질 비트 비율' },
  { label: '탐지 준비도', path: '/data/readiness', marker: '준비도 사이트 선택' },
  { label: '안전', path: '/safety', marker: '안전 이벤트 즉시 경로와 확인 이력' },
  { label: '탐색기', path: '/explore', marker: '임의 포인트를 골라 원시 데이터 탐색' },
  { label: '설정', path: '/settings', marker: '스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자' },
  { label: '탐지기 설정', path: '/settings/detectors', marker: '파라미터는 코드 기본값 위에 기본' },
  { label: 'AI 설명 설정', path: '/settings/ai', marker: 'GEMINI_API_KEY' },
  { label: '용어집', path: '/help', marker: '콘솔과 리포트에 나오는 말을 쉬운 말과 비유로' },
];

/** 정적 경로 + DB에서 찾은 실제 id로 만든 상세 경로 (id가 없으면 그 경로는 빠진다) */
export function consoleRoutes(ids: RouteIds): readonly RouteCheck[] {
  const site = ids.siteCode === null ? [] : [
    { label: '사이트 상세', path: `/sites/${encodeURIComponent(ids.siteCode)}`, marker: '오늘 KPI' },
    { label: '공정도', path: `/sites/${encodeURIComponent(ids.siteCode)}/diagram`, marker: 'FCND-GP-PID-002' },
  ];
  const finding = ids.findingId === null ? [] : [{ label: '발견사항 상세', path: `/desk/${ids.findingId}`, marker: '권고 조치 작성' }];
  const report = ids.reportId === null ? [] : [{ label: '리포트 상세', path: `/reports/${ids.reportId}`, marker: '코칭 리포트' }];
  return [...STATIC_ROUTES, ...site, ...finding, ...report];
}

/** 로그인하지 않은 채로 확인할 것: 화면은 /login으로 307, 콘솔 API는 401, 로그인 화면 자체는 200 */
export const ANONYMOUS_CHECKS: readonly { readonly path: string; readonly status: number }[] = [
  { path: '/', status: 307 },
  { path: '/desk', status: 307 },
  { path: '/api/series', status: 401 },
  { path: '/login', status: 200 },
];

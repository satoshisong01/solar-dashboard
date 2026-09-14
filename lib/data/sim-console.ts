import 'server-only';

/** 시뮬레이터 스코어카드 화면(/sim) 노출 여부. 개발 플래그 HYSOL_SHOW_SIM=1일 때만 메뉴·라우트를 연다 (설계 §4 시뮬레이터 행) */
export function isSimConsoleEnabled(): boolean {
  return process.env.HYSOL_SHOW_SIM === '1';
}

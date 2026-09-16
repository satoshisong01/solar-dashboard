// 지도 키 정규화 (순수). NEXT_PUBLIC_ 변수는 빌드 때 번들에 들어가므로 값은 화면·로그에 출력하지 않는다.

/**
 * 지도 키를 읽는다. 변수가 없을 때뿐 아니라 `NEXT_PUBLIC_KAKAO_MAP_KEY=`처럼 빈 값일 때도 '키 없음'으로 본다
 * (빈 키를 SDK에 넘기면 로딩이 실패해 '불러오지 못했습니다' 오류 화면이 나온다).
 */
export function mapKeyOf(raw: string | undefined): string | null {
  const key = raw === undefined ? '' : raw.trim();
  return key === '' ? null : key;
}

import 'server-only';
import { createAuth, type Auth } from './create-auth';

let instance: Auth | undefined;

/**
 * 첫 호출 때 인스턴스를 만든다. import만으로는 환경변수·DB를 건드리지 않으므로
 * 환경변수 없이도 `next build`가 통과한다.
 */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

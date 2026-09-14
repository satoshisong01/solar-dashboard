import { createAuthClient } from 'better-auth/react';

// 로그인은 반드시 이 클라이언트로 /api/auth를 거친다.
// 서버의 auth.api.* 호출에는 Better Auth rate limit이 적용되지 않기 때문이다.
export const authClient = createAuthClient();

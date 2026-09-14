import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth/auth';

// 요청이 올 때 인스턴스를 만든다 (빌드 시 환경변수 불필요).
export const { GET, POST } = toNextJsHandler((request: Request) => getAuth().handler(request));

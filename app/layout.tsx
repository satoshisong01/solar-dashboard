import type { Metadata } from 'next';
import { IBM_Plex_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import { BRAND } from '@/lib/brand';
import './fonts/pretendard.css';
import './globals.css';

// 사내 문서 표준 글꼴. Google Fonts에 없어 자체 호스팅한다(npm run fonts:sync, 원본 pretendard@1.3.9).
// 라이선스는 app/fonts/Pretendard-OFL.txt.
//
// 한 벌(2.06MB)이 아니라 unicode-range로 나눈 92개 구간으로 받는다. 여기서 선언하는 [91]
// 구간(라틴·숫자·기호와 가장 흔한 한글 음절, 37KB)만 preload하고, 나머지 91개 구간은
// app/fonts/pretendard.css가 'Pretendard Variable' 이름으로 선언해 화면에 그 글자가 나올 때 받는다.
// 두 벌을 --font-body 스택에 차례로 두면(globals.css) 브라우저가 글자마다 글리프가 있는 쪽을 고른다.
// 글리프를 버리는 방식이 아니라서 DB에서 온 낯선 한글도 그대로 나온다.
const pretendard = localFont({
  src: './fonts/pretendard/PretendardVariable.subset.91.woff2',
  weight: '45 920', // Variable 축(wght) 전 범위
  display: 'swap',
  variable: '--font-pretendard',
});

const plexMono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${pretendard.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

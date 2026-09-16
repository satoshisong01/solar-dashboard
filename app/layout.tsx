import type { Metadata } from 'next';
import { IBM_Plex_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import { BRAND } from '@/lib/brand';
import './globals.css';

// 사내 문서 표준 글꼴. Google Fonts에 없어 Variable woff2 한 벌(app/fonts)을 자체 호스팅한다.
// 원본: pretendard@1.3.9 dist/web/variable/woff2. 라이선스는 app/fonts/Pretendard-OFL.txt.
// 폴백 스택은 globals.css의 --font-body/--font-code.
const pretendard = localFont({
  src: './fonts/PretendardVariable.woff2',
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

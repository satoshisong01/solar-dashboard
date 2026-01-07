import './globals.css';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });

export const metadata = {
  title: 'SolarAI EMS',
  description: 'AI-powered Solar Energy Management System',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <head>
        {/* 🌟 [핵심] 이 줄이 있어야 아이콘(fa-map 등)이 보입니다! */}
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
        />
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  );
}

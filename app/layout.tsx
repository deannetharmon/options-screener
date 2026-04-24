import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Options Screener',
  description: 'BPS · BCS · IC Screener powered by TastyTrade',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

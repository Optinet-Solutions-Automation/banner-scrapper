import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Casino Banner Scraper',
  description: 'Progressive-tier casino banner image scraper with geo-targeting',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

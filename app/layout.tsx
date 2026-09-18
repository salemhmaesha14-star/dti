import './globals.css';
import type { Metadata } from 'next';
import { Cairo } from 'next/font/google';
import { ThemeToggle } from './components/ThemeToggle';

const cairo = Cairo({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-cairo',
});

export const metadata: Metadata = {
  title: 'بوابة الطالب | UDTI',
  description: 'المعهد التقاني لطب الأسنان - منصة الطلاب والإدارة',
  metadataBase: new URL('https://my-dti.netlify.app'),
  alternates: {
    canonical: 'https://my-dti.netlify.app',
  },
  openGraph: {
    title: 'بوابة الطالب | UDTI',
    description: 'المعهد التقاني لطب الأسنان - منصة الطلاب والإدارة',
    url: 'https://my-dti.netlify.app',
    siteName: 'بوابة الطالب | UDTI',
    locale: 'ar_SA',
    type: 'website',
    images: [
      {
        url: 'https://my-dti.netlify.app/institute-logo.png',
        width: 1200,
        height: 630,
        alt: 'شعار المعهد التقاني لطب الأسنان',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'بوابة الطالب | UDTI',
    description: 'المعهد التقاني لطب الأسنان - منصة الطلاب والإدارة',
    images: ['https://my-dti.netlify.app/institute-logo.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={cairo.variable}>
      <body className={cairo.className}>
        <ThemeToggle />
        {children}
      </body>
    </html>
  );
}

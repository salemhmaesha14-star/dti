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
  title: 'بوابة الطالب - المعهد التقاني لطب الأسنان | جامعة اللاذقية',
  description: 'البوابة الإلكترونية للخدمات الطلابية وبدائل برنامج الدوام والعلامات',
  metadataBase: new URL('https://my-dti.netlify.app'),
  alternates: {
    canonical: 'https://my-dti.netlify.app',
  },
  openGraph: {
    title: 'بوابة الطالب - المعهد التقاني لطب الأسنان',
    description: 'البوابة الإلكترونية للخدمات الطلابية وبدائل برنامج الدوام والعلامات',
    url: 'https://my-dti.netlify.app',
    siteName: 'بوابة الطالب',
    locale: 'ar_SA',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 1200,
        alt: 'شعار بوابة الطالب - المعهد التقاني لطب الأسنان',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'بوابة الطالب - المعهد التقاني لطب الأسنان',
    description: 'البوابة الإلكترونية للخدمات الطلابية',
    images: ['/og-image.png'],
  },
  icons: {
    icon: { url: '/institute-logo.png', type: 'image/png' },
    shortcut: '/institute-logo.png',
    apple: '/institute-logo.png',
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

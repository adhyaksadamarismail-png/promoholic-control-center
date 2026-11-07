import type { Metadata, Viewport } from 'next'
import { Inter, Poppins } from 'next/font/google'
import './globals.css'

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] })
const poppins = Poppins({ variable: '--font-poppins', subsets: ['latin'], weight: ['600', '700', '800'] })

// viewport-fit=cover agar env(safe-area-inset-*) berlaku di iPhone (header & bilah tab bawah).
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#14213d' }

export const metadata: Metadata = {
  title: 'Promo.Holic Control Center',
  description: 'Dashboard internal operasional Promo.Holic',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        {/* Sembunyikan kartu yang akan dianimasikan sebelum tampil pertama (hindari kedip). Batas 2,5 dtk bila JS gagal. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "if(!matchMedia('(prefers-reduced-motion: reduce)').matches){var d=document.documentElement;d.classList.add('js-motion');setTimeout(function(){d.classList.add('motion-ready')},2500)}",
          }}
        />
      </head>
      <body className={`${inter.variable} ${poppins.variable} font-sans antialiased`}>{children}</body>
    </html>
  )
}

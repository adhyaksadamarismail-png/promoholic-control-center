import type { Metadata } from 'next'
import { Inter, Poppins } from 'next/font/google'
import './globals.css'

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] })
const poppins = Poppins({ variable: '--font-poppins', subsets: ['latin'], weight: ['600', '700', '800'] })

export const metadata: Metadata = {
  title: 'Promo.Holic Control Center',
  description: 'Dashboard internal operasional Promo.Holic',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body className={`${inter.variable} ${poppins.variable} font-sans antialiased`}>{children}</body>
    </html>
  )
}

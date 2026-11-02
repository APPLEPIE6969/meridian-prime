import type { Metadata } from 'next'
import './globals.css'
import { DeskShell } from '@/components/DeskShell'

export const metadata: Metadata = {
  title: 'Meridian Prime — Desk',
  description: 'Multi-agent trading desk on live US market data.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DeskShell>{children}</DeskShell>
      </body>
    </html>
  )
}

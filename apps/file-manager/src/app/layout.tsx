import NavLink from '@/components/NavLink';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Knative File Manager',
  description: 'Distributed Next.js App on Knative',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex">
          {/* Sidebar Navigation */}
          <nav className="w-64 bg-black/20 backdrop-blur-xl border-r border-white/10 p-6 flex flex-col">
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-white">Knative Next</h1>
              <p className="text-xs text-purple-300">Fluid Compute POC</p>
            </div>

            <div className="space-y-2 flex-1">
              <NavLink href="/dashboard">Dashboard</NavLink>
              <NavLink href="/">Files</NavLink>
              <NavLink href="/users">Users</NavLink>
              <NavLink href="/audit">Audit Logs</NavLink>
            </div>

            <div className="pt-4 border-t border-white/10 space-y-2">
              <NavLink href="/cache">📊 Cache Monitor</NavLink>
              <NavLink href="/cache-tests">🧪 Cache Tests</NavLink>
              <NavLink href="/setup">⚙️ Setup DB</NavLink>
            </div>
          </nav>

          {/* Main Content */}
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}

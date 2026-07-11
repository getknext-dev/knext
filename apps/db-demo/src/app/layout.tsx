import type { ReactNode } from 'react';

export const metadata = {
  title: 'db-demo — @knext/db',
  description: 'Minimal runnable @knext/db example: RO read + writer server action.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

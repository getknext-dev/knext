import type { ReactNode } from 'react';

export const metadata = {
  title: 'db-demo — @getknext/db',
  description: 'Minimal runnable @getknext/db example: RO read + writer server action.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

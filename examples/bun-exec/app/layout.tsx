// Root layout. Exists to exercise the CSS pipeline on the bun-exec target: the
// example previously had no layout and no stylesheet, so a `.css` import had
// never been compiled by vinext, emitted into `.output/public`, nor served from
// the compiled binary's asset root.
import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

export const metadata = {
  title: "scale-to-zero pg demo",
  description: "A knext NextApp that wakes a scale-to-zero Postgres on first hit",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          background: "#0b0f14",
          color: "#d7e0ea",
          margin: 0,
          padding: "3rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js).
  // This is exactly how a real knext NextApp is packaged — knext builds the
  // official Next.js standalone output and ships it as a distroless Node image.
  output: "standalone",
  // Never cache the demo page — every hit must actually touch Postgres so the
  // wake path is exercised on each request.
  experimental: {
    // keep the build lean
  },
};

module.exports = nextConfig;

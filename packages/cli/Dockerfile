# Option 3: Runtime Image with Bun (Node.js Compatible)
# Uses oven/bun image to provide full Node.js compatibility (fs, path, http)
# needed for dynamically loaded Next.js bundles.

FROM oven/bun:1-slim

WORKDIR /app

# Install framework dependencies globally or in app
# ensuring they are available for the runtime and dynamically loaded pages
RUN bun add next@16.0.3 react@19.0.0 react-dom@19.0.0

# Copy the bundled bootstrap script
COPY bootstrap.js /app/bootstrap.js

# Environment
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0

# Run with Bun runtime
CMD ["bun", "run", "/app/bootstrap.js"]

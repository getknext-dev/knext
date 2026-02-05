#!/bin/bash
set -e

echo "📦 Bundling bootstrap for Bun runtime..."

# Bundle bootstrap.ts and its dependencies into a single JS file
# We use --target=bun to keep it compatible with Bun runtime
bun build packages/cli/internal/shim/bootstrap.ts \
  --bundle \
  --target=bun \
  --minify \
  --outfile bootstrap.js

echo "✅ Generated bootstrap.js"
ls -lh bootstrap.js

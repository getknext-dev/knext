# Bun Bytecode & NFT Strategy for Next.js on Knative

## Core Architecture
This project enforces a strict "Scale-to-Zero" architecture using Knative, powered by a single, monolithic Bun executable. This architecture diverges from standard Next.js deployments to achieve sub-100ms cold starts and minimal image footprints (~70MB).

### 1. The Single Binary (No `node_modules`)
*   **Goal**: The final deployment artifact must be a solitary executable file.
*   **Constraint**: The final Docker image **must not** contain a `node_modules` directory.
*   **Mechanism**:
    *   Use `@vercel/nft` (Node File Trace) to identify all file dependencies (JS, JSON, config).
    *   **Embed** these files into the Bun binary using generated `import` statements with `{ type: "file" }` attributes.
    *   `bun build --compile --bytecode --minify` bundles everything into one file.
*   **Reference**: *Architecting Next.js on Knative: The Bun Bytecode & NFT Strategy.md* (Section 2).

### 2. Bytecode Compilation
*   **Why**: To eliminate the V8/JSC parsing and compilation overhead during startup.
*   **How**: Ensure `--bytecode` flag is always used during `bun build`. This pre-compiles JS to JSC bytecode.

### 3. Decoupled Static Assets
*   **Goal**: The compute unit (Bun binary) must never serve static assets (images, CSS, JS chunks).
*   **Strategy**:
    *   Build Time: Offload `.next/static` and `public` folders to S3 or a separate Nginx sidecar/service.
    *   Runtime: Ingress rules route `/_next/static/*` away from the Knative Service.
    *   The binary should contain **zero** static asset files to minimize I/O and size.

### 4. Runtime Environment
*   **Base Image**: `gcr.io/distroless/cc-debian12` (or minimal Alpine if strictly necessary for glibc/musl valid compat).
*   **Security**: Non-root, no shell, no package manager in the final container.

### 5. Implementation Status & Divergence
> **Warning**: As of 2026-01-19, the implementation in `packages/distribution-builder` **diverges** from this standard.
> *   Current Implementation: Copies `node_modules` from standalone output to the runtime image.
> *   Required Implementation: Embed `node_modules` content via NFT-based manifest generation.

# ── Stage 1: TypeScript compilation ──────────────────────────────────────────
# Use a lean Node image just for the build step
FROM node:20-slim AS builder

WORKDIR /app

# Install all deps (including devDeps for tsc)
COPY package*.json tsconfig.json ./
RUN npm ci

# Compile TypeScript → dist/
COPY src/ ./src/
RUN npm run build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# Use the official Playwright image — Chromium + all OS-level dependencies are
# pre-installed. Do NOT switch to a smaller base image; Playwright needs system
# libs (libnss, libgbm, libasound, etc.) that are included here.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Tell Playwright where browsers live (pre-installed in the base image).
# Also skip the postinstall download when we run `npm ci` below.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Install libvips for sharp (perceptual image hashing)
RUN apt-get update && apt-get install -y --no-install-recommends libvips42 && rm -rf /var/lib/apt/lists/*

# Install production-only Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist/

# Bootstrap an empty site-memory file so the app never crashes on first start
RUN echo '{}' > /app/sites.json

# Create runtime directories (output/ holds downloaded banners, temp/ holds
# debug screenshots — both are ephemeral on Cloud Run, which is fine)
RUN mkdir -p /app/output /app/temp_screenshots

# Cloud Run injects PORT automatically (default 8080)
ENV PORT=8080
EXPOSE 8080

# Run the compiled server
CMD ["node", "dist/index.js"]

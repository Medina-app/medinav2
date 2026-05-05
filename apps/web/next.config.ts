import path from 'path';
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin Turbopack's workspace root to THIS repo (apps/web's grandparent).
  // Without this, Next.js 15 auto-detects via lockfile lookup and can pick
  // the wrong root when multiple lockfiles exist (e.g. when running from a
  // git worktree alongside the main repo). The wrong root means the wrong
  // .env.local is loaded — which broke Inngest dev mode by injecting prod
  // INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY from the main worktree's env.
  turbopack: {
    root: path.resolve(__dirname, '..', '..'),
  },
  // Workspace packages whose `src/index.ts` re-exports with `.js` extensions
  // (TS NodeNext convention). Turbopack ignores the webpack `extensionAlias`
  // below, so each package that imports from another workspace package via
  // `.js` paths must be listed here.
  transpilePackages: [
    '@medina/auth',
    '@medina/chat',
    '@medina/integrations-core',
    '@medina/integrations-whatsapp-kapso',
    '@medina/integrations-calcom',
  ],
  webpack(config) {
    // Allow ESM packages that use .js extensions in imports to resolve to .ts sources
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;

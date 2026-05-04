import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

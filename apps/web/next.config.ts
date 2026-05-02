import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ['@medina/auth'],
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

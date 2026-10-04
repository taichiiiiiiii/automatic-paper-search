import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  webpack(config, { isServer, webpack }) {
    // @paperpilot/core (workspace:*) ships TypeScript source whose own
    // internal relative imports end in ".js" (NodeNext-style, e.g.
    // "./pycompat/index.js", pointing at the sibling .ts file -- see
    // packages/core/src/index.ts). tsc resolves that fine
    // (moduleResolution: bundler), but webpack's default resolver does
    // not try ".ts"/".tsx" for a specifier that already ends in ".js".
    // This is apps/web's first real import from @paperpilot/core (P1's
    // CSP proof never imported it), so nothing exercised this path
    // before. Without this alias, `next build`/`next dev` fail with
    // "Module not found: Can't resolve './pycompat/index.js'" etc.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".js", ".ts", ".tsx"],
    };
    // Client code imports only the browser-safe subpaths
    // ("@paperpilot/core/site", "/pycompat", "/slug"); never the
    // barrel, "/schemas" (reads schemas/*.json from disk with
    // node:fs), or "/identity" (uses node:crypto).
    return config;
  },
};

export default nextConfig;

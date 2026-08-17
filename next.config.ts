import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The reference app is a demo against testnet; surface type problems at build
  // time rather than shipping past them.
  //
  // Next 16 dropped the `eslint` key from this config — linting is no longer part
  // of `next build`. `npm run typecheck` is the gate that matters here.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;

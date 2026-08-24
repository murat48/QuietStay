import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The reference app is a demo against testnet; surface type problems at build
  // time rather than shipping past them.
  //
  // Next 16 dropped the `eslint` key from this config — linting is no longer part
  // of `next build`. `npm run typecheck` is the gate that matters here.
  typescript: { ignoreBuildErrors: false },

  /**
   * Emit a self-contained server in `.next/standalone`, so the container ships
   * the traced dependencies rather than the whole of `node_modules`. Smaller
   * image, and a smaller thing to have opinions about from a security point of
   * view — nothing is present that the app does not import.
   *
   * `npm run dev` and `npm run start` are unaffected.
   */
  output: "standalone",
};

export default nextConfig;

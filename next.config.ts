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
   * A self-contained server in `.next/standalone`, for the container only.
   *
   * It ships the traced dependencies rather than the whole of `node_modules` —
   * a smaller image, and a smaller thing to have opinions about, since nothing
   * is present that the app does not import.
   *
   * **Off by default, and that is not a preference.** A managed host runs its
   * own build pipeline on top of this one and expects the ordinary output;
   * Vercel's `onBuildComplete` looks for `.next/next-server.js.nft.json`, which
   * standalone does not produce, and the build fails there rather than here.
   * The Dockerfile opts in; nothing else should.
   */
  output: process.env.QUIETSTAY_STANDALONE === "1" ? "standalone" : undefined,

  /**
   * The attestations the registry reads, named for the build rather than
   * inferred from a `readFileSync` argument.
   *
   * `loadAttestation` scopes its reads to a static folder so the tracer can
   * follow them, but the filename within it is still `right-${id}` and the
   * writable root is an environment variable. Naming the folders here is what
   * makes the guarantee independent of how well static analysis does: these
   * files are in the deployment because they were asked for.
   *
   * `/*` rather than a list of routes — five of them read attestations, and a
   * sixth added later should not silently ship without them.
   */
  outputFileTracingIncludes: {
    "/*": ["./inventory/attestations/**", "./inventory/evidence/attestations/**"],
  },
};

export default nextConfig;

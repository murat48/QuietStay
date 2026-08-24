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
   *
   * Without this the build warns "Dynamic filesystem access causes tracing of
   * the whole project" and does what it says: every source file is deployed as
   * part of the server code.
   */
  outputFileTracingIncludes: {
    "/*": ["./inventory/attestations/**", "./inventory/evidence/attestations/**"],
  },
};

export default nextConfig;

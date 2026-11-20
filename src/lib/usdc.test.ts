/**
 * Exact USDC amount handling (src/lib/usdc.ts).
 *
 *   npm run test:app
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUsdc, needsUsdcTrustline, parseUsdc } from "./usdc";

describe("parseUsdc", () => {
  it("reads whole and fractional amounts exactly", () => {
    assert.equal(parseUsdc("1"), 10_000_000n);
    assert.equal(parseUsdc("0.5"), 5_000_000n);
    assert.equal(parseUsdc("1."), 10_000_000n);
    assert.equal(parseUsdc(" 12.3456789 "), 123_456_789n);
    assert.equal(parseUsdc("0.0000001"), 1n);
    // 0.1 + 0.2 in floating point is 0.30000000000000004; here it is exact.
    assert.equal(parseUsdc("0.1") + parseUsdc("0.2"), parseUsdc("0.3"));
  });

  it("refuses rather than rounds", () => {
    for (const bad of ["", "-1", "1e3", "1,5", "0.00000001", "abc", ".5", "1.2.3"]) {
      assert.throws(() => parseUsdc(bad), `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe("formatUsdc", () => {
  it("prints the shortest exact form", () => {
    assert.equal(formatUsdc(10_000_000n), "1");
    assert.equal(formatUsdc(15_000_000n), "1.5");
    assert.equal(formatUsdc(1n), "0.0000001");
    assert.equal(formatUsdc(0n), "0");
    assert.equal(formatUsdc(-25_000_000n), "-2.5");
  });

  it("round-trips", () => {
    for (const text of ["1", "0.5", "100", "0.0000001", "99.9999999"]) {
      assert.equal(formatUsdc(parseUsdc(text)), text);
    }
  });
});

describe("needsUsdcTrustline", () => {
  const G = "GBCETLZR2XY5S3DBCWUJRNS7ITYYMOJGTQVLNNQ77P2TLRKDUHLR4AYR";
  const C = "CDSI6FMLEA5LRMCTFU2RBMVBMFHWH4TJN7PEMEWSK477S4KP2KAKOKWY";
  it("flags a G account whose balance read found no trustline", () => {
    assert.equal(needsUsdcTrustline(G, null), true);
  });
  it("does not flag a G account with a trustline, even at a zero balance", () => {
    assert.equal(needsUsdcTrustline(G, "0"), false);
    assert.equal(needsUsdcTrustline(G, "10000000"), false);
  });
  it("never flags a C account, which needs no trustline", () => {
    assert.equal(needsUsdcTrustline(C, null), false);
    assert.equal(needsUsdcTrustline(C, "0"), false);
  });
  it("claims nothing while the balance is still loading", () => {
    assert.equal(needsUsdcTrustline(G, undefined), false);
  });
});

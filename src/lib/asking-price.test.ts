import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { askingPriceProblem, priceForListing, withPrice, type AskingPrice } from "./asking-price";

const OWNER = "GBCETLZR2XY5S3DBCWUJRNS7ITYYMOJGTQVLNNQ77P2TLRKDUHLR4AYR";
const BUYER = "GB3VDHQ4DLT4HDBKAAZ55UV7J4RUMWZVBFXOESHAVBZVCV2WKC2DLANH";

const ask = (over: Partial<AskingPrice> = {}): AskingPrice => ({
  right_id: 3,
  by: OWNER,
  listed_at: 1000,
  price: "5000000",
  set_at: "2026-11-26T00:00:00.000Z",
  ...over,
});

describe("priceForListing", () => {
  it("returns the price set for the listing that stands", () => {
    assert.equal(priceForListing([ask()], 3, { by: OWNER, listedAt: 1000 })?.price, "5000000");
  });
  it("ignores a price from an earlier listing of the same week", () => {
    assert.equal(priceForListing([ask()], 3, { by: OWNER, listedAt: 2000 }), null);
  });
  it("ignores a price set by an earlier holder", () => {
    assert.equal(priceForListing([ask()], 3, { by: BUYER, listedAt: 1000 }), null);
  });
  it("has no price for a week that is not listed", () => {
    assert.equal(priceForListing([ask()], 3, null), null);
  });
});

describe("askingPriceProblem", () => {
  it("refuses zero", () => assert.notEqual(askingPriceProblem(0n, null), null));
  it("refuses more than one payment may be", () => assert.notEqual(askingPriceProblem(20_000_000n, 10_000_000n), null));
  it("accepts up to the cap", () => assert.equal(askingPriceProblem(10_000_000n, 10_000_000n), null));
});

describe("withPrice", () => {
  it("keeps one price per week", () => {
    const next = withPrice([ask(), ask({ right_id: 4 })], ask({ price: "1" }));
    assert.equal(next.length, 2);
    assert.equal(next.find((p) => p.right_id === 3)?.price, "1");
  });
});

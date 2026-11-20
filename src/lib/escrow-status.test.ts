/**
 * Escrow status labels (src/lib/escrow-status.ts) against the contract's
 * windows: collectable exactly from check-in + 24 h.
 *
 *   npm run test:app
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escrowStatus, FIRST_NIGHT_SECS } from "./escrow-status";

const checkIn = 1_783_123_200;

describe("escrowStatus", () => {
  it("is funded until check-in + 24 h, then collectable", () => {
    assert.match(escrowStatus({ state: "Funded", checkIn }, checkIn + FIRST_NIGHT_SECS - 1).label, /^funded · collectable from/);
    assert.equal(escrowStatus({ state: "Funded", checkIn }, checkIn + FIRST_NIGHT_SECS).label, "collectable");
  });
  it("names the other states", () => {
    assert.equal(escrowStatus({ state: "Disputed", checkIn }, 0).label, "disputed");
    assert.equal(escrowStatus({ state: "PaidOut", checkIn }, 0).label, "paid out");
    assert.equal(escrowStatus({ state: "Refunded", checkIn }, 0).label, "refunded");
  });
});

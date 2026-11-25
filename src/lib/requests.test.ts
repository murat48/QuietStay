import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { SEALED_TTL_DAYS, expireSealed, parseSealedBlob, type IssuanceRequest } from "./requests";

const ask = (delivered_at?: string): IssuanceRequest => ({
  id: "a",
  by: "G…",
  secret_hash: "1",
  requested_at: "2026-11-25T00:00:00Z",
  status: "issued",
  ...(delivered_at ? { sealed_record: { blob: "x".repeat(200), delivered_at } } : {}),
});

describe("the issuance inbox (D3 as amended 2026-11-25)", () => {
  it("takes a sealed record only as bounded base64url", () => {
    const ok = "A-_z".repeat(400);
    assert.equal(parseSealedBlob(ok), ok);
    assert.throws(() => parseSealedBlob("short"), /sealed record/);
    assert.throws(() => parseSealedBlob("a".repeat(20_000)), /sealed record/);
    assert.throws(() => parseSealedBlob("a+b/".repeat(100)), /sealed record/);
    assert.throws(() => parseSealedBlob({ blob: "x" }), /sealed record/);
  });

  it(`drops a sealed record after ${SEALED_TTL_DAYS} days, and keeps a fresh one`, () => {
    const now = Date.parse("2026-12-30T00:00:00Z");
    const old = ask("2026-11-25T00:00:00Z");
    const fresh = ask("2026-12-20T00:00:00Z");
    const none = ask();
    assert.equal(expireSealed([old, fresh, none], now), true);
    assert.equal(old.sealed_record, undefined);
    assert.ok(fresh.sealed_record);
    assert.equal(expireSealed([fresh, none], now), false);
  });
});

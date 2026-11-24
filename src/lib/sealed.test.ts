import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { b64u, checkedAskPublicKey, newRecipientKey, open, seal, unb64u } from "./sealed";

describe("checkedAskPublicKey (the owner's key carried by an issuance ask)", () => {
  it("accepts the key that hashes to the ask's key_hash, and a sealed reply opens with the private half", async () => {
    const key = await newRecipientKey();
    const pk = b64u(key.publicRaw);
    assert.equal(await checkedAskPublicKey(pk, key.keyHash), pk);

    // What the issuer's browser does the moment it issues.
    const blob = await seal(unb64u(pk), key.keyHash, { v: 1, right_id: 12 });
    assert.deepEqual(await open(key.privateKey, key.keyHash, blob), { v: 1, right_id: 12 });
  });

  it("is optional", async () => {
    assert.equal(await checkedAskPublicKey(undefined, undefined), undefined);
    assert.equal(await checkedAskPublicKey(null, "00".repeat(32)), undefined);
  });

  it("refuses a key that does not hash to key_hash, or comes without one", async () => {
    const a = await newRecipientKey();
    const b = await newRecipientKey();
    await assert.rejects(checkedAskPublicKey(b64u(b.publicRaw), a.keyHash), /does not hash to key_hash/);
    await assert.rejects(checkedAskPublicKey(b64u(a.publicRaw), undefined), /needs the key_hash/);
  });

  it("refuses something that is not a raw P-256 public key", async () => {
    const a = await newRecipientKey();
    await assert.rejects(checkedAskPublicKey(b64u(a.publicRaw.subarray(1)), a.keyHash), /not a raw P-256/);
    await assert.rejects(checkedAskPublicKey("not base64!", a.keyHash), /base64url/);
    await assert.rejects(checkedAskPublicKey(42, a.keyHash), /base64url string/);
  });
});

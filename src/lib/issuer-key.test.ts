import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hash, Keypair } from "@stellar/stellar-sdk";

import { cleanDetails, detailValues, intakeKeyMessage, intakeSignatureIsValid } from "./issuer-key";

const issuer = Keypair.random();
const other = Keypair.random();
const message = intakeKeyMessage({ contract: "CABC", network: "Test SDF Network ; September 2015", keyHash: "ab".repeat(32) });
const sep53 = (kp: Keypair, m: string) =>
  kp.sign(hash(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(m)]))).toString("base64");

describe("intakeSignatureIsValid", () => {
  it("accepts the issuer's SEP-53 signature", () => {
    assert.equal(intakeSignatureIsValid(issuer.publicKey(), message, sep53(issuer, message)), true);
  });
  it("refuses another account's signature", () => {
    assert.equal(intakeSignatureIsValid(issuer.publicKey(), message, sep53(other, message)), false);
  });
  it("refuses a signature of another key", () => {
    const swapped = intakeKeyMessage({ contract: "CABC", network: "Test SDF Network ; September 2015", keyHash: "cd".repeat(32) });
    assert.equal(intakeSignatureIsValid(issuer.publicKey(), swapped, sep53(issuer, message)), false);
  });
  it("refuses garbage", () => {
    assert.equal(intakeSignatureIsValid(issuer.publicKey(), message, "not base64!"), false);
    assert.equal(intakeSignatureIsValid("GNOTANACCOUNT", message, sep53(issuer, message)), false);
  });
});

describe("cleanDetails and detailValues", () => {
  it("keeps known fields only, trimmed, and types them for the record", () => {
    const d = cleanDetails({ owner_name: "  Ada ", resort_bedrooms: "2", resort_features: "pool, sea view", nonsense: "x", owner_email: "" });
    assert.deepEqual(d, { owner_name: "Ada", resort_bedrooms: "2", resort_features: "pool, sea view" });
    assert.deepEqual(detailValues(d), [
      { path: "owner.name", value: "Ada" },
      { path: "resort.bedrooms", value: 2 },
      { path: "resort.features", value: ["pool", "sea view"] },
    ]);
  });
  it("refuses an overlong field", () => {
    assert.throws(() => cleanDetails({ owner_name: "x".repeat(201) }));
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hash, Keypair } from "@stellar/stellar-sdk";

import { cleanDetails, detailValues, intakeKeyMessage, intakeSignatureIsValid, renewalDetails } from "./issuer-key";

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

describe("renewalDetails", () => {
  it("carries the record over, 52 weeks later, with the use year following", () => {
    const d = renewalDetails({
      owner: { name: "Ada", email: "ada@example.invalid", stellar_account: "G…" },
      resort: { name: "Cliffside", city: "Lagos", country: "Portugal", unit: "14B", bedrooms: 2, sleeps: 4, features: ["pool", "wifi"] },
      week: { check_in: "2026-12-26", check_out: "2027-01-02", use_year: 2026, week_number: 52 },
      title: { deed_reference: "D-1", registry: "R", recorded_on: "2019-03-22" },
      maintenance_fees: { annual_amount: "820.00", currency: "EUR", paid_through: "2026-12-31", outstanding: "0.00" },
    });
    assert.equal(d.week_check_in, "2027-12-25");
    assert.equal(d.week_check_out, "2028-01-01");
    assert.equal(d.week_use_year, "2027");
    assert.equal(d.resort_bedrooms, "2");
    assert.equal(d.resort_features, "pool, wifi");
    assert.equal(d.title_deed, "D-1");
    assert.equal(d.fees_through, "2026-12-31");
  });
});

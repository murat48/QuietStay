import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hash, Keypair } from "@stellar/stellar-sdk";

import { cleanDetails, detailValues, intakeKeyMessage, intakeSignatureIsValid, nextYearIso, renewalDetails } from "./issuer-key";

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
  it("keeps 29 February where the next year has one, and uses the 28th where not", () => {
    assert.equal(nextYearIso("2027-02-28"), "2028-02-28");
    assert.equal(nextYearIso("2028-02-29"), "2029-02-28");
    assert.equal(nextYearIso("2026-12-31"), "2027-12-31");
    assert.equal(nextYearIso("2026-13-01"), undefined);
  });
  it("carries the record over, the same dates a year later, with the use year following", () => {
    const d = renewalDetails({
      owner: { name: "Ada", email: "ada@example.invalid", stellar_account: "G…" },
      resort: { name: "Cliffside", city: "Lagos", country: "Portugal", unit: "14B", bedrooms: 2, sleeps: 4, features: ["pool", "wifi"] },
      week: { check_in: "2026-11-23", check_out: "2026-11-26", use_year: 2026, week_number: 48 },
      title: { deed_reference: "D-1", registry: "R", recorded_on: "2019-03-22" },
      maintenance_fees: { annual_amount: "820.00", currency: "EUR", paid_through: "2026-12-31", outstanding: "0.00" },
    });
    assert.equal(d.week_check_in, "2027-11-23");
    assert.equal(d.week_check_out, "2027-11-26");
    assert.equal(d.week_use_year, "2027");
    assert.equal(d.resort_bedrooms, "2");
    assert.equal(d.resort_features, "pool, wifi");
    assert.equal(d.title_deed, "D-1");
    assert.equal(d.fees_through, "2026-12-31");
  });
});

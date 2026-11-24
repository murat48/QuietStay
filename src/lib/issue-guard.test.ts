import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { reservedOwnerReason } from "./issue-guard";

const FEE = "GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z";
const ISSUER = "GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE";
const SIGN_IN = "GDC2YUKYIPDETC6M7QVOL4222SJF6MVYCW5ZOOVFQEZQQPYIENPLRRGQ";
const OWNER = "GBCETLZR2XY5S3DBCWUJRNS7ITYYMOJGTQVLNNQ77P2TLRKDUHLR4AYR";

describe("reservedOwnerReason", () => {
  const reserved = { feeAccount: FEE, issuer: ISSUER, signIn: SIGN_IN };

  it("refuses the fee account, the issuer and the sign-in key as a week's owner", () => {
    assert.match(reservedOwnerReason(FEE, reserved) ?? "", /fee account/);
    assert.match(reservedOwnerReason(ISSUER, reserved) ?? "", /issuer/);
    assert.match(reservedOwnerReason(SIGN_IN, reserved) ?? "", /sign-in key/);
    assert.match(reservedOwnerReason(` ${FEE} `, reserved) ?? "", /fee account/);
  });

  it("allows any other account, and says nothing about an empty field", () => {
    assert.equal(reservedOwnerReason(OWNER, reserved), null);
    assert.equal(reservedOwnerReason("", reserved), null);
    assert.equal(reservedOwnerReason(FEE, {}), null);
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { contextRuleIdsFor, countAuthContexts } from "./auth-contexts";

const WALLET = "CDN2YBRTQHV24XF3R2ONJSYXPQH7IA4CX3ZNVWLAK7OU5KSLAQD7S37D";
const RIGHTS = "CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function call(contract: string, fn: string, subs: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args: [nativeToScVal(1, { type: "u32" })],
      }),
    ),
    subInvocations: subs,
  });
}

function entry(root: xdr.SorobanAuthorizedInvocation) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

describe("countAuthContexts", () => {
  it("counts one context for a sign-in (no sub-invocations)", () => {
    const e = entry(call(RIGHTS, "web_auth_verify"));
    assert.equal(countAuthContexts(e), 1);
    assert.deepEqual(contextRuleIdsFor(e, 0), [0]);
  });

  it("counts the USDC approve beneath an offer (the #3014 case)", () => {
    const e = entry(call(RIGHTS, "offer_rent", [call(USDC, "approve")]));
    assert.equal(countAuthContexts(e), 2);
    assert.deepEqual(contextRuleIdsFor(e, 0), [0, 0]);
  });

  it("counts nested sub-invocations depth first", () => {
    const e = entry(call(RIGHTS, "a", [call(USDC, "b", [call(USDC, "c")]), call(USDC, "d")]));
    assert.equal(countAuthContexts(e), 4);
  });
});

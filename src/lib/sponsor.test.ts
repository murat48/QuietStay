/**
 * The fee route's policy (src/lib/sponsor.ts), rule by rule.
 *
 *   npm run test:app
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";

import { CONTRACT_ID, SMART_ACCOUNT_WASM_HASH, USDC_CONTRACT_ID } from "./config";
import { assertFeeKeyIsolated, checkSponsored, LIMITS, SponsorRefusal, weekActedOn } from "./sponsor";

const fee = Keypair.random().publicKey();
const wallet = StrKey.encodeContract(Keypair.random().rawPublicKey());
const other = StrKey.encodeContract(Keypair.random().rawPublicKey());

const call = (contract: string, fn: string, args: xdr.ScVal[]) =>
  xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
  );

const entry = (signer: string, contract: string, fn: string, args: xdr.ScVal[] = [], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 10,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: subs,
    }),
  });

const walletCreation = (wasm: string) =>
  xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: new Address(Keypair.random().publicKey()).toScAddress(), salt: Buffer.alloc(32, 7) }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")),
      constructorArgs: [],
    }),
  );

const refused = (f: () => unknown, re: RegExp) => assert.throws(f, (e) => e instanceof SponsorRefusal && re.test(e.message));

describe("the fee route sponsors", () => {
  it("a call to the rights contract authorized by a smart wallet", () => {
    const args = [new Address(wallet).toScVal(), nativeToScVal(1n, { type: "u64" })];
    const c = checkSponsored(call(CONTRACT_ID, "list", args), [entry(wallet, CONTRACT_ID, "list", args)], fee);
    assert.equal(c.kind, "call");
    assert.equal(c.wallet, wallet);
  });
  it("an offer whose allowance the wallet authorizes on the USDC contract (Step 3, D12)", () => {
    const approve = entry(wallet, USDC_CONTRACT_ID, "approve", approveArgs(CONTRACT_ID)).rootInvocation();
    const c = checkSponsored(
      call(CONTRACT_ID, "create_rental_offer", []),
      [entry(wallet, CONTRACT_ID, "create_rental_offer", [], [approve])],
      fee,
    );
    assert.equal(c.kind, "call");
  });
  it("the creation of a smart wallet of the pinned account WASM", () => {
    const c = checkSponsored(walletCreation(SMART_ACCOUNT_WASM_HASH), [], fee);
    assert.equal(c.kind, "wallet-deployment");
    assert.match(c.wallet!, /^C/);
  });
});

/** `approve(from = wallet, spender, 1 USDC, ledger 2000)`. */
const approveArgs = (spender: string) => [
  new Address(wallet).toScVal(),
  new Address(spender).toScVal(),
  nativeToScVal(10_000_000n, { type: "i128" }),
  nativeToScVal(2000, { type: "u32" }),
];

describe("the fee route refuses", () => {
  it("any network but the deployment's own", () =>
    refused(() => checkSponsored(call(CONTRACT_ID, "list", []), [], fee, "Public Global Stellar Network ; September 2015"), /this deployment's network only/));
  it("a call to any other contract", () => refused(() => checkSponsored(call(other, "transfer", []), [], fee), /only calls to the QuietStay/));
  it("a contract of any other WASM", () => refused(() => checkSponsored(walletCreation("00".repeat(32)), [], fee), /only smart wallets/));
  it("an authorization that reaches another contract", () =>
    refused(() => checkSponsored(call(CONTRACT_ID, "list", []), [entry(wallet, other, "transfer")], fee), /other than QuietStay/));
  it("a sub-invocation into another contract", () => {
    const sub = entry(wallet, other, "transfer").rootInvocation();
    refused(() => checkSponsored(call(CONTRACT_ID, "list", []), [entry(wallet, CONTRACT_ID, "list", [], [sub])], fee), /other than QuietStay/);
  });
  it("a USDC approve for any spender but the rights contract", () => {
    const approve = entry(wallet, USDC_CONTRACT_ID, "approve", approveArgs(other)).rootInvocation();
    refused(
      () => checkSponsored(call(CONTRACT_ID, "create_rental_offer", []), [entry(wallet, CONTRACT_ID, "create_rental_offer", [], [approve])], fee),
      /only USDC call sponsored/,
    );
  });
  it("any USDC function but approve, such as a transfer", () => {
    const transfer = entry(wallet, USDC_CONTRACT_ID, "transfer", approveArgs(CONTRACT_ID)).rootInvocation();
    refused(
      () => checkSponsored(call(CONTRACT_ID, "create_rental_offer", []), [entry(wallet, CONTRACT_ID, "create_rental_offer", [], [transfer])], fee),
      /only USDC call sponsored/,
    );
  });
  it("a USDC approve at the top of an authorization tree", () =>
    refused(
      () => checkSponsored(call(CONTRACT_ID, "create_rental_offer", []), [entry(wallet, USDC_CONTRACT_ID, "approve", approveArgs(CONTRACT_ID))], fee),
      /only USDC call sponsored/,
    ));
  it("the fee account as an argument", () =>
    refused(() => checkSponsored(call(CONTRACT_ID, "transfer", [new Address(fee).toScVal()]), [], fee), /fee account appears in an argument/));
  it("the fee account inside a nested argument", () =>
    refused(
      () => checkSponsored(call(CONTRACT_ID, "transfer", [xdr.ScVal.scvVec([xdr.ScVal.scvVec([new Address(fee).toScVal()])])]), [], fee),
      /fee account appears/,
    ));
  it("the fee account as an authorizing address", () =>
    refused(() => checkSponsored(call(CONTRACT_ID, "list", []), [entry(fee, CONTRACT_ID, "list")], fee), /asked to authorize/));
  it("source-account credentials, which the fee account's signature would cover", () => {
    const e = entry(wallet, CONTRACT_ID, "list");
    e.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
    refused(() => checkSponsored(call(CONTRACT_ID, "list", []), [e], fee), /signed by the fee account/);
  });
  it("to run with a fee key that is the issuer, the sign-in key, or a holder", () => {
    const others = { issuer: Keypair.random().publicKey(), signingKey: Keypair.random().publicKey(), holders: [wallet] };
    refused(() => assertFeeKeyIsolated(others.issuer, others), /issuer/);
    refused(() => assertFeeKeyIsolated(others.signingKey, others), /sign-in key/);
    refused(() => assertFeeKeyIsolated(wallet, others), /holds a right/);
    assert.doesNotThrow(() => assertFeeKeyIsolated(fee, others));
  });
});

describe("the fee route's limits against draining it (2026-11-28)", () => {
  const u64 = (n: number) => nativeToScVal(n, { type: "u64" });
  const who = new Address(wallet).toScVal();
  it("names the week of a listing change, an offer or a record request", () => {
    assert.equal(weekActedOn(call(CONTRACT_ID, "list", [who, u64(23), nativeToScVal(null)])), 23);
    assert.equal(weekActedOn(call(CONTRACT_ID, "unlist", [who, u64(23)])), 23);
    assert.equal(weekActedOn(call(CONTRACT_ID, "create_rental_offer", [who, u64(7), u64(1), u64(2)])), 7);
    assert.equal(weekActedOn(call(CONTRACT_ID, "request_record", [who, u64(9)])), 9);
  });
  it("names no week for other calls", () => {
    assert.equal(weekActedOn(call(CONTRACT_ID, "cancel_offer", [who, u64(17)])), null);
    assert.equal(weekActedOn(call(CONTRACT_ID, "accept_rental", [who, u64(17)])), null);
  });
  it("keeps a daily XLM budget, wallet-creation limits and a per-week limit", () => {
    assert.ok(LIMITS.stroopsPerDay > 0 && LIMITS.walletsPerIpPerDay > 0 && LIMITS.walletsPerDay > 0 && LIMITS.perWeekPerDay > 0);
    // A day's budget is spent by no fewer than a handful of the largest transactions.
    assert.ok(BigInt(LIMITS.stroopsPerDay) >= LIMITS.maxFeeStroops * 10n);
  });
});

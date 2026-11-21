/**
 * Telling a USDC token failure from QuietStay's own (src/lib/errors.ts,
 * src/lib/contract.ts `failureEvents`).
 *
 *   npm run test:app
 *
 * The fixture is a real testnet simulation: accept_sale by a seller with no
 * USDC trustline. The RPC's error text is only `HostError: Error(Contract,
 * #13)`; the token's #13 (TrustlineMissingError) is QuietStay's #13
 * (AlreadyListed), which is what the app once showed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";

import { failureEvents } from "./contract";
import { explainFailure, describeContractFailure, type FailureEvent } from "./errors";

const capture = JSON.parse(readFileSync("src/lib/fixtures/token-trustline-simulation.json", "utf8")) as {
  error: string;
  rights: string;
  token: string;
  events: FailureEvent[];
};

describe("explainFailure", () => {
  it("shows the real trustline capture as the token's failure, not QuietStay's #13", () => {
    assert.equal(capture.error, "HostError: Error(Contract, #13)");
    // The text alone is what the app used to read.
    assert.match(describeContractFailure(capture.error), /AlreadyListed/);
    const message = explainFailure(capture.error, { events: capture.events, invoked: capture.rights, token: capture.token });
    assert.match(message, /USDC token refused this/);
    assert.match(message, /no USDC trustline/);
    assert.match(message, /TrustlineMissingError/);
    assert.doesNotMatch(message, /AlreadyListed/);
  });

  it("keeps QuietStay's own error when the failure starts in QuietStay", () => {
    const events: FailureEvent[] = [
      { contract: null, error: false, code: null },
      { contract: capture.rights, error: true, code: 13 },
    ];
    const message = explainFailure("HostError: Error(Contract, #13)", { events, invoked: capture.rights, token: capture.token });
    assert.match(message, /AlreadyListed/);
  });

  it("reads a call made to the token itself as the token's, even without events", () => {
    const message = explainFailure("HostError: Error(Contract, #10)", { invoked: capture.token, token: capture.token });
    assert.match(message, /USDC balance is too low/);
    assert.match(message, /BalanceError/);
  });

  it("names another contract when the failure starts there", () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 7));
    const events: FailureEvent[] = [
      { contract: other, error: true, code: 3 },
      { contract: capture.rights, error: true, code: 3 },
    ];
    const message = explainFailure("HostError: Error(Contract, #3)", { events, invoked: capture.rights, token: capture.token });
    assert.match(message, new RegExp(`Another contract, ${other}`));
    assert.doesNotMatch(message, /InvalidValidity/);
  });
});

describe("failureEvents", () => {
  const event = (contract: string, topics: xdr.ScVal[]) =>
    new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: Address.fromString(contract).toScAddress().contractId(),
        type: xdr.ContractEventType.diagnostic(),
        body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data: xdr.ScVal.scvVoid() })),
      }),
    });

  it("reads the emitter and the contract code of an error event, as the capture's shape", () => {
    const err = xdr.ScVal.scvError(xdr.ScError.sceContract(13));
    const [token, rights, call] = failureEvents([
      event(capture.token, [xdr.ScVal.scvSymbol("error"), err]),
      event(capture.rights, [xdr.ScVal.scvSymbol("error"), err]),
      event(capture.rights, [xdr.ScVal.scvSymbol("fn_call"), xdr.ScVal.scvSymbol("transfer_from")]),
    ]);
    assert.deepEqual(token, { contract: capture.token, error: true, code: 13 });
    assert.deepEqual(rights, { contract: capture.rights, error: true, code: 13 });
    assert.deepEqual(call, { contract: capture.rights, error: false, code: null });
  });
});

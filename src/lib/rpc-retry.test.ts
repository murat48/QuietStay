/**
 * The read-only retry (src/lib/rpc-retry.ts).
 *
 *   npm run test:app
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTransient, networkCodes, readOnly } from "./rpc-retry";

/** What Node's fetch throws when the connection fails. */
function fetchFailed(...codes: string[]): Error {
  const inner = codes.map((code) => Object.assign(new Error(code), { code }));
  return new TypeError("fetch failed", { cause: new AggregateError(inner) });
}

const quiet = { log: () => {}, pause: async () => {} };

describe("networkCodes", () => {
  it("reads the codes under fetch failed's AggregateError", () => {
    assert.deepEqual(networkCodes(fetchFailed("ECONNRESET", "ETIMEDOUT")), ["ECONNRESET", "ETIMEDOUT"]);
  });
  it("reads an HTTP status", () => {
    assert.deepEqual(networkCodes({ response: { status: 503 } }), ["HTTP 503"]);
  });
});

describe("readOnly", () => {
  it("retries a dropped connection and returns the answer", async () => {
    let calls = 0;
    const logged: string[] = [];
    const v = await readOnly(
      "getLatestLedger",
      async () => {
        calls += 1;
        if (calls < 3) throw fetchFailed("ECONNRESET");
        return 42;
      },
      { ...quiet, log: (m: string) => logged.push(m) },
    );
    assert.equal(v, 42);
    assert.equal(calls, 3);
    assert.equal(logged.length, 2);
    assert.match(logged[0]!, /getLatestLedger: attempt 1 of 3 failed \(ECONNRESET\)/);
  });

  it("gives up after three attempts and throws the last failure", async () => {
    let calls = 0;
    await assert.rejects(
      readOnly("simulate", async () => {
        calls += 1;
        throw fetchFailed("ETIMEDOUT");
      }, quiet),
      /fetch failed/,
    );
    assert.equal(calls, 3);
  });

  it("does not retry anything that is not a connection failure", async () => {
    let calls = 0;
    await assert.rejects(
      readOnly("simulate", async () => {
        calls += 1;
        throw new Error("Error(Contract, #4)");
      }, quiet),
    );
    assert.equal(calls, 1);
    assert.equal(isTransient(new Error("HostError: Error(Contract, #19)")), false);
    assert.equal(isTransient({ response: { status: 400 } }), false);
    assert.equal(isTransient({ response: { status: 503 } }), true);
    // Browsers' own words for a dropped connection.
    assert.equal(isTransient(new TypeError("Failed to fetch")), true);
    assert.equal(isTransient(new TypeError("NetworkError when attempting to fetch resource.")), true);
  });
});

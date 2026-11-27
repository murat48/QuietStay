import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isoDateToUnix } from "./record";
import { renewalOpensFrom, renewalProblem, startOfUseYear } from "./requests";

const NOW = isoDateToUnix("2026-11-27") + 12 * 3600;
const Y2026 = isoDateToUnix("2027-01-01"); // a 2026 week's window ends here
const Y2027 = isoDateToUnix("2028-01-01");

describe("renewals", () => {
  it("knows a window's use year", () => {
    assert.equal(startOfUseYear(Y2026), isoDateToUnix("2026-01-01"));
    assert.equal(startOfUseYear(Y2027), isoDateToUnix("2027-01-01"));
  });

  it("renews this year's week by hand", () => {
    assert.equal(renewalProblem({ renewOf: 1, auto: false, validityUntil: Y2026, asks: [], now: NOW }), null);
  });

  it("does not renew next year's week by hand before its year begins", () => {
    const problem = renewalProblem({ renewOf: 2, auto: false, validityUntil: Y2027, asks: [], now: NOW });
    assert.match(problem ?? "", /from 2027-01-01/);
    // From 1 January 2027 it can.
    assert.equal(renewalProblem({ renewOf: 2, auto: false, validityUntil: Y2027, asks: [], now: isoDateToUnix("2027-01-01") }), null);
  });

  it("lets an automatic one be filed ahead, opening when the use year is over", () => {
    assert.equal(renewalProblem({ renewOf: 2, auto: true, validityUntil: Y2027, asks: [], now: NOW }), null);
    assert.equal(renewalOpensFrom(Y2026, NOW), "2027-01-01T00:00:00.000Z");
    assert.equal(renewalOpensFrom(Y2026, Y2026 + 1), undefined);
  });

  it("renews a week once", () => {
    assert.match(
      renewalProblem({ renewOf: 1, auto: false, validityUntil: Y2026, asks: [{ renew_of: 1, status: "issued" }], now: NOW }) ?? "",
      /already been renewed/,
    );
    assert.match(
      renewalProblem({ renewOf: 1, auto: true, validityUntil: Y2026, asks: [{ renew_of: 1, status: "open" }], now: NOW }) ?? "",
      /already has a renewal waiting/,
    );
    // Declined or cancelled, it can be asked again.
    const tried = [
      { renew_of: 1, status: "declined" as const },
      { renew_of: 1, status: "cancelled" as const },
    ];
    assert.equal(renewalProblem({ renewOf: 1, auto: false, validityUntil: Y2026, asks: tried, now: NOW }), null);
  });
});

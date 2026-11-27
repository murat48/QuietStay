import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isoDateToUnix } from "./record";
import { renewableFrom, renewalOpensFrom, renewalProblem, startOfUseYear } from "./requests";

// The week from the request: in on 21.11.2026, out on 27.11.2026.
const OUT = isoDateToUnix("2026-11-27");
const at = (iso: string) => isoDateToUnix(iso) + 12 * 3600;

describe("renewals", () => {
  it("knows a window's use year", () => {
    assert.equal(startOfUseYear(isoDateToUnix("2027-01-01")), isoDateToUnix("2026-01-01"));
  });

  it("renews by hand from the day after check-out", () => {
    assert.equal(renewableFrom(OUT), isoDateToUnix("2026-11-28"));
    for (const day of ["2026-11-21", "2026-11-25", "2026-11-27"]) {
      const problem = renewalProblem({ renewOf: 1, auto: false, weekEnd: OUT, asks: [], now: at(day) });
      assert.match(problem ?? "", /from 2026-11-28/, day);
    }
    assert.equal(renewalProblem({ renewOf: 1, auto: false, weekEnd: OUT, asks: [], now: isoDateToUnix("2026-11-28") }), null);
    assert.equal(renewalProblem({ renewOf: 1, auto: false, weekEnd: OUT, asks: [], now: at("2026-12-30") }), null);
  });

  it("does not renew next year's week by hand now, so renewals cannot run ahead", () => {
    const nextOut = isoDateToUnix("2027-11-26");
    assert.match(renewalProblem({ renewOf: 2, auto: false, weekEnd: nextOut, asks: [], now: at("2026-11-28") }) ?? "", /from 2027-11-27/);
  });

  it("lets an automatic one be filed ahead, opening when the use year is over", () => {
    assert.equal(renewalProblem({ renewOf: 1, auto: true, weekEnd: OUT, asks: [], now: at("2026-11-22") }), null);
    assert.equal(renewalOpensFrom(isoDateToUnix("2027-01-01"), at("2026-11-22")), "2027-01-01T00:00:00.000Z");
    assert.equal(renewalOpensFrom(isoDateToUnix("2027-01-01"), isoDateToUnix("2027-01-01") + 1), undefined);
  });

  it("renews a week once", () => {
    const now = at("2026-12-01");
    assert.match(
      renewalProblem({ renewOf: 1, auto: false, weekEnd: OUT, asks: [{ renew_of: 1, status: "issued" }], now }) ?? "",
      /already been renewed/,
    );
    assert.match(
      renewalProblem({ renewOf: 1, auto: true, weekEnd: OUT, asks: [{ renew_of: 1, status: "open" }], now }) ?? "",
      /already has a renewal waiting/,
    );
    // Declined or cancelled, it can be asked again.
    const tried = [
      { renew_of: 1, status: "declined" as const },
      { renew_of: 1, status: "cancelled" as const },
    ];
    assert.equal(renewalProblem({ renewOf: 1, auto: false, weekEnd: OUT, asks: tried, now }), null);
  });
});

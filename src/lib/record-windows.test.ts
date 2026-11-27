import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { notYetValid } from "./format";
import { isoDateToUnix, onChainWindows, type OwnershipRecord } from "./record";

const week = (checkIn: string, checkOut: string, useYear: number) =>
  ({ week: { check_in: checkIn, check_out: checkOut, use_year: useYear } }) as unknown as OwnershipRecord;

describe("onChainWindows", () => {
  it("keeps the use year when it has begun", () => {
    const w = onChainWindows(week("2026-12-19", "2026-12-26", 2026), isoDateToUnix("2026-11-27") + 3600);
    assert.equal(w.validity.from, isoDateToUnix("2026-01-01"));
    assert.equal(w.validity.until, isoDateToUnix("2027-01-01"));
  });

  it("opens a week for next year on the day it is issued, so it can be listed now", () => {
    const now = isoDateToUnix("2026-11-27") + 15 * 3600;
    const w = onChainWindows(week("2027-12-18", "2027-12-25", 2027), now);
    assert.equal(w.validity.from, isoDateToUnix("2026-11-27"));
    assert.equal(w.validity.until, isoDateToUnix("2028-01-01"));
    // What the contract requires: the window encloses the week.
    assert.ok(w.validity.from <= w.period.start && w.period.end <= w.validity.until);
    assert.equal(notYetValid(w.validity.from, now), false);
  });

  it("tells a week that has not opened from one that is over", () => {
    const now = isoDateToUnix("2026-11-27");
    assert.equal(notYetValid(isoDateToUnix("2027-01-01"), now), true);
    assert.equal(notYetValid(isoDateToUnix("2026-01-01"), now), false);
  });
});

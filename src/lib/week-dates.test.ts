import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { addDays, followCheckIn, todayIso } from "./week-dates";

describe("week dates", () => {
  it("today is the local date", () => {
    assert.equal(todayIso(new Date(2026, 10, 26, 23, 30)), "2026-11-26");
  });
  it("adds days across a month and a year", () => {
    assert.equal(addDays("2026-11-28", 7), "2026-12-05");
    assert.equal(addDays("2026-12-29", 7), "2027-01-05");
  });
  it("check-out keeps the stay's length and the use year follows check-in", () => {
    assert.deepEqual(followCheckIn("2027-02-01", { checkIn: "2026-11-26", checkOut: "2026-11-30" }), { checkOut: "2027-02-05", useYear: 2027 });
  });
  it("a week when the old dates give no length", () => {
    assert.deepEqual(followCheckIn("2026-12-01", {}), { checkOut: "2026-12-08", useYear: 2026 });
  });
  it("nothing while the date is half typed", () => {
    assert.equal(followCheckIn("2026-1", {}), null);
  });
});

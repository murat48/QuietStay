import assert from "node:assert/strict";
import { test } from "node:test";

import { anchor, droppedHeadings, headings } from "./evidence-guard";

test("headings ignore lines inside code fences", () => {
  const md = "# A\n\n```\n# not a heading\n```\n\n### Phase 3: B\ntext\n";
  assert.deepEqual(headings(md), ["# A", "### Phase 3: B"]);
});

test("a rerun that would drop a hand-added section is caught", () => {
  const current = "# Evidence\n## Phase 2\n### Phase 3: the web-auth contract\n### Phase 3: a signing bug\n";
  const next = "# Evidence\n## Phase 2\n### Phase 3: the web-auth contract\n";
  assert.deepEqual(droppedHeadings(current, next), ["### Phase 3: a signing bug"]);
});

test("moving a section keeps it", () => {
  const current = "# Evidence\n## Phase 2\n### Phase 3: X\n";
  const next = "# Evidence\n### Phase 3: X\n## Phase 2\n";
  assert.deepEqual(droppedHeadings(current, next), []);
});

test("anchors match the links EVIDENCE.md already uses", () => {
  assert.equal(
    anchor("### Phase 3: the SEP-45 web-auth contract (passkey sign-in)"),
    "phase-3-the-sep-45-web-auth-contract-passkey-sign-in",
  );
  assert.equal(anchor("## Phase 2 — proof-gated transfers"), "phase-2--proof-gated-transfers");
});

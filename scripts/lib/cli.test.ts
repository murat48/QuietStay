import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadEnvVars } from "./cli";

/** A fake .env.local in a temporary directory; the real one is never read here. */
function withEnvFile(content: string, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "qs-env-"));
  const cwd = process.cwd();
  writeFileSync(join(dir, ".env.local"), content);
  try {
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadEnvVars", () => {
  it("sets only the named variables, and nothing else from the file", () => {
    delete process.env.QS_T_WANTED;
    delete process.env.QS_T_OTHER;
    withEnvFile('QS_T_OTHER=not-for-you\nQS_T_WANTED="quoted value"\n# QS_T_WANTED=commented\n', () => {
      assert.deepEqual(loadEnvVars(["QS_T_WANTED"]), ["QS_T_WANTED"]);
    });
    assert.equal(process.env.QS_T_WANTED, "quoted value");
    assert.equal(process.env.QS_T_OTHER, undefined);
    delete process.env.QS_T_WANTED;
  });

  it("keeps a value already in the environment, and handles export and single quotes", () => {
    process.env.QS_T_SET = "from the shell";
    delete process.env.QS_T_EXPORTED;
    withEnvFile("QS_T_SET=from-file\nexport QS_T_EXPORTED='a b'\n", () => {
      loadEnvVars(["QS_T_SET", "QS_T_EXPORTED"]);
    });
    assert.equal(process.env.QS_T_SET, "from the shell");
    assert.equal(process.env.QS_T_EXPORTED, "a b");
    delete process.env.QS_T_SET;
    delete process.env.QS_T_EXPORTED;
  });

  it("does nothing without a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-env-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      assert.deepEqual(loadEnvVars(["QS_T_WANTED"]), []);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

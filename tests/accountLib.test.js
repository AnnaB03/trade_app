import { test } from "node:test";
import assert from "node:assert/strict";

test("one account size, default $10K, env wins", async () => {
  delete process.env.ACCOUNT_SIZE;
  const { accountSize, DEFAULT_ACCOUNT_SIZE } = await import("../app/api/accountLib.js");
  assert.equal(DEFAULT_ACCOUNT_SIZE, 10000);
  assert.equal(accountSize(), 10000);
  process.env.ACCOUNT_SIZE = "25000";
  assert.equal(accountSize(), 25000);
  process.env.ACCOUNT_SIZE = "nope";
  assert.equal(accountSize(), 10000, "garbage falls back, never 0");
  delete process.env.ACCOUNT_SIZE;
});

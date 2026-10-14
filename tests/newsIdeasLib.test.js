import { test } from "node:test";
import assert from "node:assert/strict";
const n = await import("../app/api/newsIdeasLib.js");

const put = { symbol: "nvda", action: "put", triggerPrice: 219.5, triggerDirection: "below", invalidation: 222.4, target: 214.8, why: "hot CPI", catalyst: "CPI" };

test("an ideas block is read from the end of a report, and stripped from what is shown", () => {
  const text = "Brief\nstuff\n```ideas-json\n[" + JSON.stringify(put) + "]\n```\n";
  assert.equal(n.parseIdeasBlock(text).length, 1);
  assert.deepEqual(n.parseIdeasBlock("no block"), []);
  assert.deepEqual(n.parseIdeasBlock("```ideas-json\nnot json\n```"), []);
  assert.equal(n.stripIdeasBlock(text), "Brief\nstuff");
});

test("a valid news idea is normalised; levels, reward:risk and distance are checked", () => {
  const v = n.validateNewsIdea(put, { last: 220.8 });
  assert.equal(v.ok, true);
  assert.equal(v.idea.symbol, "NVDA");
  assert.equal(v.idea.action, "PUT");
  assert.equal(v.idea.rewardRisk, 1.62);
  assert.match(n.validateNewsIdea({ ...put, invalidation: 218 }, { last: 220.8 }).reason, /wrong sides/);
  assert.match(n.validateNewsIdea({ ...put, target: 217 }, { last: 220.8 }).reason, /reward:risk/);
  assert.match(n.validateNewsIdea(put, { last: 240 }).reason, /more than 3%/);
  assert.match(n.validateNewsIdea({ ...put, action: "BUY" }, { last: 220.8 }).reason, /CALL or PUT/);
  assert.match(n.validateNewsIdea({ ...put, triggerDirection: "near" }, { last: 220.8 }).reason, /above or below/);
  const call = { symbol: "MU", action: "CALL", triggerPrice: 910, triggerDirection: "above", invalidation: 900, target: 930 };
  assert.equal(n.validateNewsIdea(call, { last: 905 }).ok, true);
});

test("ingest: at most 3 per report, the server picks the contract, and every refusal says why", async () => {
  const written = [];
  const many = Array.from({ length: 5 }, (_, i) => ({ ...put, symbol: ["NVDA", "AMD", "MU", "INTC", "AVGO"][i] }));
  const text = "```ideas-json\n" + JSON.stringify([...many.slice(0, 2), { ...put, symbol: "BAD1" }, ...many.slice(2)]) + "\n```";
  const r = await n.ingestNewsIdeas(text, {
    quote: async () => 220.8,
    pickContract: async (sym) => (sym === "AMD" ? null : { strike: 220, expiration: "2026-10-16", leg: { occ: `${sym}261016P00220000`, bid: 4, ask: 4.1, delta: -0.5 } }),
    appendIdea: (row) => { written.push(row); return { id: `id-${written.length}` }; },
    accountSize: 25000, source: "test",
  });
  assert.deepEqual(r.accepted.map((a) => a.symbol), ["NVDA"]);
  assert.equal(r.rejected.length, 2, "AMD has no contract; BAD1 is not a symbol; the 4th and 5th are past the limit of 3");
  assert.equal(written[0].strategy, "news");
  assert.equal(written[0].flatByClose, true);
  assert.equal(written[0].leg.occ, "NVDA261016P00220000");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../lib/store.mjs";

// The serve layer is thin over the store; these test the store queries the API
// exposes, which is where a wallet's correctness actually rests.
test("the scan feed returns commitments in tree order", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 1, "t");
  s.ingestBatch("P", {
    commitments: [
      { commitment: "0xc2", leafIndex: 2, encryptedOutput: "0x", ledger: 12, eventId: "e2" },
      { commitment: "0xc0", leafIndex: 0, encryptedOutput: "0x", ledger: 10, eventId: "e0" },
      { commitment: "0xc1", leafIndex: 1, encryptedOutput: "0x", ledger: 11, eventId: "e1" },
    ],
    fromLedger: 10, toLedger: 12,
  });
  assert.deepEqual(s.commitmentsFrom("P", -1, 100).map((c) => c.leafIndex), [0, 1, 2]);
  // resume from a cursor
  assert.deepEqual(s.commitmentsFrom("P", 0, 100).map((c) => c.leafIndex), [1, 2]);
});

test("spent check is the boolean a wallet needs", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 1, "t");
  s.ingestBatch("P", {
    nullifiers: [{ nullifier: "0xdead", ledger: 5, eventId: "n0" }],
    fromLedger: 5, toLedger: 5,
  });
  assert.equal(s.isSpent("P", "0xdead"), true);
  assert.equal(s.isSpent("P", "0xbeef"), false);
});

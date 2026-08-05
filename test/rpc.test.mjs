import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcError } from "../lib/rpc.mjs";

test("retention refusal is recognised and its window parsed", () => {
  const e = new RpcError(
    "getEvents: startLedger must be within the ledger range: 3844914 - 3965873"
  );
  assert.equal(e.isOutsideRetention, true);
  assert.deepEqual(e.retentionWindow, { oldest: 3844914, latest: 3965873 });
});

test("a transport error is not mistaken for retention", () => {
  const e = new RpcError("getEvents: HTTP 503", { http: 503 });
  assert.equal(e.isOutsideRetention, false);
  assert.equal(e.retentionWindow, null);
});

// If an RPC surfaces the retention refusal with a non-200 status AND the message
// in the body, call() folds that message in, so it is still classified as
// retention (the handoff must fire), not masked as a bare transport failure.
test("a retention refusal carried on an HTTP error status is still recognised", () => {
  const e = new RpcError(
    "getEvents: HTTP 400: startLedger must be within the ledger range: 100 - 200",
    { http: 400 }
  );
  assert.equal(e.isOutsideRetention, true);
  assert.deepEqual(e.retentionWindow, { oldest: 100, latest: 200 });
});

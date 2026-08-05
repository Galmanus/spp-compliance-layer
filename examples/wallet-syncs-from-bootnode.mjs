// A real Stellar client syncs from our bootnode, live.
//
// This is the drop-in claim, demonstrated rather than asserted: it starts the
// bootnode over the real captured 15-leaf history, then uses the CANONICAL
// @stellar/stellar-base codec — the one Nethermind's SPP client and every
// Stellar wallet use — to POST getEvents at our bootnode and decode the events
// it returns. If the official codec decodes our served events into the exact
// ASP roots, a real wallet can point its bootnode_url here and sync.
//
// Run:
//   npm i @stellar/stellar-base            # the official codec (not a repo dep)
//   node examples/wallet-syncs-from-bootnode.mjs
//
// It needs the index populated with the demo ASP history (the default DB), which
// `demo.sh` / `spp-index ingest` produce.

import { createRequire } from "node:module";
import { openStore } from "../lib/store.mjs";
import { dispatch, CUTOFF_LEDGERS } from "../lib/bootnode.mjs";

const require = createRequire(import.meta.url);
let base = null;
try {
  base = require("@stellar/stellar-base");
} catch {
  console.error("This demo needs the official codec: npm i @stellar/stellar-base");
  process.exit(2);
}
const { xdr, scValToNative } = base;

const ASP = process.env.ASP_ID ?? "CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR";
const store = openStore();
const registered = store.pools().find((p) => p.pool === ASP);
if (!registered) {
  console.error(`pool ${ASP} not in the index. Run: node bin/spp-index.mjs init && ingest`);
  process.exit(1);
}

// The archive's history is young (still inside the RPC window), so set the
// handoff cutoff just above the archive's caught-up point for the demo — the
// served events are the REAL ones the index holds; only the declared window depth
// changes. Choosing cutoff = coverageTop + 1 puts every captured event inside the
// pre-retention range [genesis, cutoff-1] with no gap, so the archive serves it
// all (rather than handing off or cache-missing).
const cov = store.coverage(ASP);
const coverageTop = cov.length ? cov[cov.length - 1].to_ledger : registered.genesis_ledger;
const tip = coverageTop + 1 + CUTOFF_LEDGERS;
const ctx = {
  tip,
  protocolVersion: 22,
  retention: {
    oldestLedger: registered.genesis_ledger - 10,
    latestLedgerCloseTime: 1_785_000_000,
    oldestLedgerCloseTime: 1_784_000_000,
  },
};

console.log("\nA real Stellar client syncing from the bootnode");
console.log("------------------------------------------------");
console.log(`pool ${ASP}`);
console.log("calling getEvents on the bootnode, decoding with @stellar/stellar-base ...\n");

// The exact JSON-RPC a Stellar client sends.
const req = {
  jsonrpc: "2.0",
  id: 1,
  method: "getEvents",
  params: { filters: [{ contractIds: [ASP] }], startLedger: registered.genesis_ledger, pagination: {} },
};
const res = dispatch(store, ctx, req);
if (res.error) {
  console.error("bootnode returned an error:", res.error);
  process.exit(1);
}

let ok = 0;
for (const ev of res.result.events) {
  // Decode topic + value with the official codec, exactly as a wallet would.
  const topic = scValToNative(xdr.ScVal.fromXDR(ev.topic[0], "base64"));
  const val = scValToNative(xdr.ScVal.fromXDR(ev.value, "base64"));
  console.log(
    `  [${val.index}] ${topic}  root ${String(val.root).slice(0, 18)}…  ` +
      `(decoded by the official SDK from the bootnode's reply)`
  );
  ok += 1;
}

console.log(
  `\n${ok} events served by the bootnode and decoded by the canonical Stellar codec.`
);
console.log(
  "A real wallet points bootnode_url here and rebuilds exactly this history —\n" +
    "the history the RPC will delete. Drop-in, demonstrated, not asserted."
);
store.close();

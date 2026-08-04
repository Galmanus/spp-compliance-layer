#!/usr/bin/env node
// A minimal wallet, and the one thing it proves: that without this index it
// loses its money after seven days.
//
// A privacy wallet has no "balance" call. It rebuilds its balance by scanning
// every commitment ever emitted and trial-decrypting each one. This script does
// that scan twice — once against the raw RPC, once against the index — and shows
// the RPC path failing for exactly the history the index kept.
//
// It does not implement real note decryption (that is Nethermind's SDK); it
// implements the SCAN, which is where the seven-day cliff bites. A "note found"
// here is a commitment the wallet's scan could reach; the point is reachability,
// not the cipher.
//
// Usage: node examples/wallet-rebuild.mjs <asp-or-pool-contract-id>

import { openStore } from "../lib/store.mjs";
import { getEvents, measureRetention, RpcError } from "../lib/rpc.mjs";

const pool = process.argv[2];
if (!pool) {
  console.error("usage: node examples/wallet-rebuild.mjs <contract-id>");
  process.exit(2);
}

const line = (s) => console.log(s);

async function scanViaRpc(genesis) {
  // What a wallet with no index does: ask the RPC for history from genesis.
  try {
    const page = await getEvents({ startLedger: genesis, contractIds: [pool], limit: 200 });
    return { ok: true, reachable: page.events.length };
  } catch (err) {
    if (err instanceof RpcError && err.isOutsideRetention) {
      return { ok: false, reason: "genesis is past the RPC's 7-day window", window: err.retentionWindow };
    }
    throw err;
  }
}

async function scanViaRpc_at(startLedger) {
  try {
    const page = await getEvents({ startLedger, contractIds: [pool], limit: 1 });
    return { ok: true, reachable: page.events.length };
  } catch (err) {
    if (err instanceof RpcError && err.isOutsideRetention) {
      return { ok: false, reason: err.message.replace(/^getEvents:\s*/, "") };
    }
    throw err;
  }
}

function scanViaIndex(store) {
  // What a wallet WITH the index does: read the full captured history.
  const commitments = store.commitmentsFrom(pool, -1, 100000);
  const roots = store.aspRootSteps(pool);
  return { reachable: commitments.length + roots.length };
}

async function main() {
  const store = store_open();
  const p = store.pools().find((x) => x.pool === pool);
  if (!p) {
    line(`pool ${pool} is not registered in the index. Run: spp-index init / ingest`);
    process.exit(1);
  }
  const genesis = p.genesis_ledger;
  const ret = await measureRetention();

  line(`\nA wallet rebuilding its balance for pool\n  ${pool}\n  genesis ledger ${genesis.toLocaleString()}\n`);
  line(`The RPC currently serves from ledger ${ret.oldestLedger.toLocaleString()} ` +
    `(${ret.days.toFixed(2)} days).\n`);

  line("Path A — no index, straight to the RPC (what most wallets do):");
  const rpc = await scanViaRpc(genesis);
  if (rpc.ok) {
    line(`  reached ${rpc.reachable} events. Genesis is still inside the window —`);
    line(`  but it leaves in ${((genesis - ret.oldestLedger) * 5 / 86400).toFixed(2)} days, and then this path fails.\n`);
  } else {
    line(`  FAILED: ${rpc.reason}.`);
    line(`  The wallet cannot see its own history. Its notes are unspendable.\n`);
  }

  line("Path A' — proof the cliff is real, not future: ask for a ledger already gone.");
  const gone = ret.oldestLedger - 1000; // 1000 ledgers below the RPC floor
  const cliff = await scanViaRpc_at(gone);
  if (!cliff.ok) {
    line(`  requesting ledger ${gone.toLocaleString()} (below the RPC floor):`);
    line(`  RPC REFUSES: "${cliff.reason}".`);
    line(`  Any pool whose genesis has crossed that floor is unreachable this way — permanently.
`);
  } else {
    line(`  (the floor moved; re-run — this asks for history strictly older than the RPC serves)
`);
  }

  line("Path B — the same wallet, pointed at the index:");
  const idx = scanViaIndex(store);
  line(`  reached ${idx.reachable} captured records, from genesis, regardless of the RPC window.`);
  line(`  The wallet rebuilds. This is the difference the index makes.\n`);

  store.close();
}

// tiny indirection so the import stays at top and the store path is overridable
function store_open() {
  return openStore(process.env.NOTEWATCH_DB);
}

main();

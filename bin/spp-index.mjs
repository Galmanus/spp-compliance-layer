#!/usr/bin/env node
// spp-index — capture, audit, serve.
//
//   spp-index init      register the deployed testnet pools
//   spp-index ingest    walk events from genesis and write them down
//   spp-index audit     report coverage, gaps, and time left before the
//                       network forgets what this index has not yet captured
//   spp-index retention just the window measurement, for a quick check

import { openStore } from "../lib/store.mjs";
import { ingestAll } from "../lib/ingest.mjs";
import { measureRetention, getLatestLedger } from "../lib/rpc.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

// From NethermindEth/stellar-private-payments deployments/testnet/deployments.json.
// Genesis ledgers are the deployment ledgers recorded there, and they are what
// make completeness checkable: coverage is meaningful only against a known
// starting point.
const TESTNET_POOLS = [
  {
    pool: "CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU",
    genesis: 3899359,
    label: "SPP pool (native XLM)",
  },
  {
    pool: "CCBOHPJ2TM24EZ4BJGT5ZHQD4F5N47J6WMJHSBXUA25NZMKPZOXD7XL2",
    genesis: 3899361,
    label: "SPP pool (classic asset)",
  },
  {
    pool: "CD3IV5JWN5Y2LDGDTY24PPZFCPD62QGJTCCSFEQNAHCOO3E7IAEQPXCF",
    genesis: 3899350,
    label: "ASP membership (root history)",
  },
  {
    pool: "CAUJSKPEK6EOEULYMBZ7FNLAPSJUKDLAMVKF2KHTDDA7XNUQZVXXSLZ4",
    genesis: 3899350,
    label: "ASP non-membership (root history)",
  },
];

const fmt = (n) => n.toLocaleString("en-US");

async function cmdInit() {
  const store = openStore();
  for (const p of TESTNET_POOLS) {
    store.registerPool(p.pool, p.genesis, p.label);
    console.log(`registered ${p.label}\n  ${p.pool} from ledger ${fmt(p.genesis)}`);
  }
  store.close();
}

async function cmdRetention() {
  const r = await measureRetention();
  console.log(
    `retention window: ${fmt(r.ledgers)} ledgers = ${r.days.toFixed(2)} days ` +
      `(${r.measuredCloseTimes ? "from ledger close times" : "estimated at 5s/ledger"})`
  );
  console.log(`  oldest servable ledger: ${fmt(r.oldestLedger)}`);
  console.log(`  chain tip:              ${fmt(r.latestLedger)}`);
  for (const p of TESTNET_POOLS) {
    const head = p.genesis - r.oldestLedger;
    const days = (head * 5) / 86_400;
    console.log(
      head < 0
        ? `  ${p.label}: genesis ALREADY OUT OF REACH by ${fmt(-head)} ledgers`
        : `  ${p.label}: genesis expires from the RPC in ${days.toFixed(2)} days`
    );
  }
}

async function cmdIngest() {
  const store = openStore();
  const { tip, results } = await ingestAll(store);
  console.log(`chain tip ${fmt(tip)}\n`);
  for (const r of results) {
    console.log(`${r.pool}`);
    console.log(
      `  pages ${r.pages}  commitments ${r.commitments}  nullifiers ${r.nullifiers}` +
        (r.otherEvents ? `  other ${r.otherEvents}` : "")
    );
    console.log(`  scanned through ledger ${fmt(r.scannedThrough)}, ${r.rowsWritten} new rows`);
    if (r.lostToRetention) {
      console.log(`  LOST TO RETENTION: the RPC no longer serves this range`);
    }
    if (r.daysToGenesisLoss != null) {
      console.log(
        r.genesisAlreadyLost
          ? `  genesis is already past the RPC floor — this index is the only copy`
          : `  ${r.daysToGenesisLoss.toFixed(2)} days before genesis leaves the RPC`
      );
    }
    if (r.gaps.length) {
      console.log(`  GAPS (${r.gaps.length}):`);
      for (const g of r.gaps.slice(0, 5)) console.log(`    ${fmt(g.from)} .. ${fmt(g.to)}`);
    } else {
      console.log(`  no gaps from genesis to ${fmt(r.scannedThrough)}`);
    }
    console.log();
  }
  store.close();
}

async function cmdAudit() {
  const store = openStore();
  const { sequence: tip } = await getLatestLedger();
  const r = await measureRetention();
  console.log(`audit at chain tip ${fmt(tip)}, RPC floor ${fmt(r.oldestLedger)}\n`);

  let anyGap = false;
  for (const p of store.pools()) {
    const gaps = store.gaps(p.pool, tip);
    const counts = store.counts(p.pool);
    const cov = store.coverage(p.pool);
    console.log(`${p.label ?? p.pool}`);
    console.log(`  ${p.pool}`);
    console.log(
      `  genesis ${fmt(p.genesis_ledger)}  commitments ${counts.commitments}  nullifiers ${counts.nullifiers}`
    );
    console.log(`  coverage spans: ${cov.map((c) => `${fmt(c.from_ledger)}-${fmt(c.to_ledger)}`).join(", ") || "none"}`);
    if (gaps.length) {
      anyGap = true;
      console.log(`  INCOMPLETE — ${gaps.length} gap(s):`);
      for (const g of gaps.slice(0, 5)) {
        const recoverable = g.from >= r.oldestLedger;
        console.log(
          `    ${fmt(g.from)} .. ${fmt(g.to)}  ${recoverable ? "still re-fetchable" : "GONE from the RPC"}`
        );
      }
    } else {
      console.log(`  COMPLETE from genesis to chain tip`);
    }
    console.log();
  }

  const history = store.retentionHistory(5);
  if (history.length > 1) {
    console.log("retention floor, as observed by this index:");
    for (const h of history) {
      console.log(`  ${h.observed_at}  floor ${fmt(h.floor_ledger)}  tip ${fmt(h.latest_ledger)}`);
    }
    console.log(
      "\nThe floor moves. Every ledger it passes is history that exists here and\n" +
        "nowhere else a wallet can reach."
    );
  }

  store.close();
  process.exit(anyGap ? 1 : 0);
}

async function cmdWatch() {
  const intervalSec = Number(process.argv[3] ?? 30);
  const store = openStore();
  console.log(
    `watching: ingest every ${intervalSec}s, capturing history before the RPC\n` +
      `window slides past it. Ctrl-C to stop; state persists in the DB.\n`
  );
  let ticks = 0;
  const tick = async () => {
    ticks += 1;
    try {
      const { tip, results } = await ingestAll(store);
      const totals = results.reduce(
        (a, r) => ({
          rows: a.rows + r.rowsWritten,
          commitments: a.commitments + r.commitments,
          asp: a.asp + (r.aspRoots ?? 0),
        }),
        { rows: 0, commitments: 0, asp: 0 }
      );
      const closest = results
        .map((r) => r.daysToGenesisLoss)
        .filter((d) => d != null)
        .sort((a, b) => a - b)[0];
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(
        `[${stamp}] tick ${ticks}  tip ${fmt(tip)}  +${totals.rows} rows ` +
          `(${totals.commitments} commitments, ${totals.asp} asp roots)  ` +
          (closest != null ? `runway ${closest.toFixed(2)}d` : "")
      );
      const lost = results.filter((r) => r.genesisAlreadyLost);
      if (lost.length) {
        console.log(`  ! ${lost.length} pool(s) past the RPC floor — this index is now their only copy`);
      }
    } catch (err) {
      console.error(`[watch] ingest error (will retry): ${err.message}`);
    }
  };
  await tick();
  const timer = setInterval(tick, intervalSec * 1000);
  process.on("SIGINT", () => {
    clearInterval(timer);
    store.close();
    console.log("\nstopped. captured history is durable in the DB.");
    process.exit(0);
  });
}

async function cmdAttest() {
  const pool = process.argv[3];
  if (!pool) {
    console.error("usage: spp-index attest <asp-contract-id>");
    console.error("  proves the captured ASP root history is an append-only chain");
    process.exit(2);
  }
  const store = openStore();
  const steps = store.aspRootSteps(pool);
  store.close();

  if (steps.length === 0) {
    console.log(`no ASP root history captured for ${pool} yet.`);
    console.log(
      "This attests the history the index holds; run `ingest` first, and note\n" +
        "the pool must have emitted LeafAddedEvents. The deployed testnet ASP has\n" +
        "none yet — the attestation is proven here over captured history, not\n" +
        "fabricated, so an empty history attests nothing rather than pretending."
    );
    process.exit(0);
  }

  // The attestation binary is a Rust crate IN THIS REPO (attestation/), so a
  // bare clone builds and runs Layer 3 without a separate checkout:
  //   cd attestation && cargo build --release
  const prover = process.env.ATTEST_BIN ??
    join(HERE, "..", "attestation", "target", "release", "attest-asp-history");
  const stepsJson = join(tmpdir(), `asp-steps-${Date.now()}.json`);
  const outDir = join(tmpdir(), `asp-attest-${Date.now()}`);
  writeFileSync(stepsJson, JSON.stringify(steps.map((s) => ({ index: s.index, root: s.root }))));

  console.log(`attesting ${steps.length} ASP root updates for ${pool} ...`);
  const out = execFileSync(prover, [stepsJson, outDir], { maxBuffer: 1 << 24 }).toString();
  const r = JSON.parse(out.trim().split("\n").pop());
  console.log(`  post-quantum attestation: ${r.proof_bytes} bytes`);
  console.log(`  covers root indices ${steps[0].index}..${steps[steps.length - 1].index}`);
  console.log(`  proof at ${r.proof}`);
  console.log(
    "\nThis proves the captured root history is a consistent append-only chain —\n" +
      "monotone gap-free indices, root chaining, endpoints pinned — with a hash-based\n" +
      "Circle-STARK. No trusted setup, nothing a quantum adversary undoes, unlike the\n" +
      "Groth16 the ASP roots are attested by today."
  );
}

const cmd = process.argv[2];
const commands = { init: cmdInit, ingest: cmdIngest, watch: cmdWatch, audit: cmdAudit, retention: cmdRetention, attest: cmdAttest };
if (!commands[cmd]) {
  console.error("usage: spp-index <init|ingest|watch|audit|retention|attest>");
  process.exit(2);
}
await commands[cmd]();

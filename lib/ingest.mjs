// The ingest loop.
//
// Two properties matter more than throughput, and both are about what happens
// when something goes wrong:
//
// **Coverage is claimed only for ledgers actually scanned.** A page of events
// proves nothing about ledgers past its last event, so the span recorded ends
// at the last ledger the RPC confirmed it had walked — not at the newest
// ledger in the chain, and not at the highest ledger that happened to contain
// an event. Over-claiming coverage is the one bug an audit could not catch,
// because the audit reads the same table.
//
// **The retention floor is recorded on every pass.** It slides forward while
// the index runs, and the series is the evidence that the window is real and
// moving. It also tells the operator something urgent: once the floor passes a
// pool's genesis ledger, any history not already captured is gone from the
// network for good.

import { getEvents, getLatestLedger, RpcError } from "./rpc.mjs";
import { decodeEvent } from "./decode.mjs";

/**
 * Walk events for one pool from `fromLedger` to the chain tip, writing as it
 * goes. Returns a report rather than logging one, so callers decide what to
 * print and tests can assert on it.
 */
export async function ingestPool(store, pool, { fromLedger, pageLimit = 200, maxPages = 10_000, onPage } = {}) {
  const started = Date.now();
  const report = {
    pool,
    fromLedger,
    pages: 0,
    commitments: 0,
    nullifiers: 0,
    otherEvents: 0,
    rowsWritten: 0,
    scannedThrough: fromLedger - 1,
    retention: null,
    truncated: false,
    lostToRetention: false,
  };

  let cursor = null;
  let startLedger = fromLedger;

  for (;;) {
    if (report.pages >= maxPages) {
      report.truncated = true;
      break;
    }

    let page;
    try {
      page = await getEvents(
        cursor
          ? { cursor, contractIds: [pool], limit: pageLimit }
          : { startLedger, contractIds: [pool], limit: pageLimit }
      );
    } catch (err) {
      // The one failure that is not retryable: the history asked for has
      // already left the network. Report it as such rather than as an outage,
      // because the remedy is completely different — there is none.
      if (err instanceof RpcError && err.isOutsideRetention) {
        report.lostToRetention = true;
        report.retentionError = err.retentionWindow;
        break;
      }
      throw err;
    }

    report.pages += 1;
    report.retention = {
      oldestLedger: page.oldestLedger,
      latestLedger: page.latestLedger,
    };

    const commitments = [];
    const nullifiers = [];
    const aspRoots = [];
    let maxLedgerSeen = report.scannedThrough;

    for (const ev of page.events) {
      const d = decodeEvent(ev);
      maxLedgerSeen = Math.max(maxLedgerSeen, d.ledger ?? 0);
      if (d.kind === "commitment") commitments.push(d);
      else if (d.kind === "nullifier") nullifiers.push(d);
      else if (d.kind === "asp_root") aspRoots.push(d);
      else report.otherEvents += 1;
    }
    for (const a of aspRoots) {
      report.rowsWritten += store.ingestAspRoot(pool, a);
    }
    report.aspRoots = (report.aspRoots ?? 0) + aspRoots.length;

    // What this page actually proves about coverage. An empty page from a
    // cursor proves the RPC walked to the tip and found nothing; a full page
    // proves only as far as its last event, because more may follow in the
    // same ledger.
    const scannedTo = page.events.length < pageLimit
      ? page.latestLedger
      : maxLedgerSeen;

    report.rowsWritten += store.ingestBatch(pool, {
      commitments,
      nullifiers,
      fromLedger: startLedger,
      toLedger: Math.max(startLedger, scannedTo),
    });
    report.commitments += commitments.length;
    report.nullifiers += nullifiers.length;
    report.scannedThrough = Math.max(report.scannedThrough, scannedTo);

    if (page.oldestLedger != null && page.latestLedger != null) {
      store.recordRetention(page.oldestLedger, page.latestLedger);
    }

    onPage?.(report);

    // A short page means the tip was reached: stop rather than spin.
    if (page.events.length < pageLimit || !page.cursor) break;
    cursor = page.cursor;
    startLedger = null;
  }

  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * Ingest every registered pool, and report how close each one is to losing its
 * own history. `daysToGenesisLoss` is the number that decides whether this
 * index is a convenience or the last copy.
 */
export async function ingestAll(store, { pageLimit = 200 } = {}) {
  const { sequence: tip } = await getLatestLedger();
  const results = [];

  for (const p of store.pools()) {
    const covered = store.coverage(p.pool);
    // Resume from the end of contiguous coverage that starts at genesis;
    // otherwise start at genesis and let coverage merging sort out the rest.
    const head = covered.find((c) => c.from_ledger <= p.genesis_ledger);
    const from = head ? head.to_ledger + 1 : p.genesis_ledger;

    const r = await ingestPool(store, p.pool, { fromLedger: Math.min(from, tip), pageLimit });
    r.genesisLedger = p.genesis_ledger;
    r.gaps = store.gaps(p.pool, r.scannedThrough);
    r.counts = store.counts(p.pool);

    if (r.retention?.oldestLedger != null) {
      const ledgersOfHeadroom = p.genesis_ledger - r.retention.oldestLedger;
      r.ledgersToGenesisLoss = ledgersOfHeadroom;
      r.daysToGenesisLoss = (ledgersOfHeadroom * 5) / 86_400;
      r.genesisAlreadyLost = ledgersOfHeadroom < 0;
    }
    results.push(r);
  }
  return { tip, results };
}

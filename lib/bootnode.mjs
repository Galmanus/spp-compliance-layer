// A verifiable bootnode.
//
// Nethermind's SPP client (sdk/client/src/sync.rs) already knows the RPC forgets
// events after ~7 days: on the retention refusal it hands the sync off to an
// optional `bootnode_url` — a service that serves the pre-retention history the
// main RPC no longer will. Nethermind ships one (tools/bootnode) and, in
// docs/src/bootnode.md, documents its own open trust risks:
//
//   "the bootnode can serve incorrect history, omit events, or selectively
//    censor data" ... "a malicious bootnode could return an incorrect fromLedger"
//
// with the only offered mitigation being "cross-check history using multiple RPC
// providers" — a social check, not a cryptographic one.
//
// This module speaks the SAME JSON-RPC surface their client already talks to
// (getEvents map-params, getLatestLedger, the -32002 retention handoff and the
// -32004 cache-miss), so their UNMODIFIED client can point `bootnode_url` here.
// The difference is that the history this bootnode serves is provable: a
// companion `getCoverage` returns the completeness proof for the served range,
// so a "selective omission" is a visible gap rather than silent corruption, and
// the Layer-3 attestation makes a "forged history" one that cannot produce a
// valid append-only proof at all.

// Their handoff cutoff is "tip - 5 days" (docs/src/bootnode.md:9). Match it, in
// ledgers, at Stellar's ~5s cadence: 5 days * 86400 / 5 = 86,400 ledgers.
const CUTOFF_LEDGERS = 86_400;

// JSON-RPC application error codes, identical to tools/bootnode/src/rpc.rs.
const RETENTION_HANDOFF_CODE = -32002;
const CACHE_MISS_CODE = -32004;
const INVALID_PARAMS_CODE = -32602;
const METHOD_NOT_FOUND_CODE = -32601;

function rpcError(code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return e;
}

// Reconstruct the on-chain event shape from a stored row. For the ASP
// LeafAddedEvent this is exact: topic symbol "LeafAdded", value map
// {index:u64, leaf:u256, root:u256} — the same shape lib/decode.mjs reads back.
function toSorobanEvent(pool, row) {
  const base = {
    type: "contract",
    ledger: row.ledger,
    contractId: pool,
    id: row.eventId,
    pagingToken: row.eventId,
  };
  if (row.kind === "asp_root") {
    return {
      ...base,
      topic: [{ symbol: "LeafAdded" }],
      value: {
        map: [
          { key: { symbol: "index" }, val: { u64: String(row.leafIndex) } },
          { key: { symbol: "leaf" }, val: { u256: String(row.leaf) } },
          { key: { symbol: "root" }, val: { u256: String(row.root) } },
        ],
      },
    };
  }
  // Commitment pools emit NewCommitmentEvent(commitment, index, ...).
  return {
    ...base,
    topic: [{ symbol: "NewCommitment" }],
    value: {
      map: [
        { key: { symbol: "index" }, val: { u64: String(row.leafIndex) } },
        { key: { symbol: "commitment" }, val: { u256: String(row.leaf) } },
      ],
    },
  };
}

// getLatestLedger — the tip this bootnode has ingested to. A wallet uses it to
// know how far the archive reaches before deciding where to hand back to its RPC.
export function getLatestLedgerResult(store, tip) {
  // The served tip is the smallest coverage upper bound across tracked pools:
  // the archive is only as complete as its least-caught-up pool.
  const pools = store.pools();
  let served = tip;
  for (const p of pools) {
    const cov = store.coverage(p.pool);
    const top = cov.length ? cov[cov.length - 1].to_ledger : p.genesis_ledger;
    served = Math.min(served, top);
  }
  return { sequence: served, id: String(served) };
}

// getEvents — serve pre-retention history, or hand off. The control flow mirrors
// tools/bootnode/src/rpc.rs: within the retention window the archive defers to
// the wallet's own RPC (-32002); a range the archive has not cached yet is a
// cache miss (-32004); otherwise return the events plus a cursor.
export function getEventsResult(store, tip, params) {
  const pool = firstContractId(params);
  if (!pool) return { error: rpcError(INVALID_PARAMS_CODE, "a contractId filter is required") };

  const registered = store.pools().find((p) => p.pool === pool);
  if (!registered) {
    return { error: rpcError(INVALID_PARAMS_CODE, `unknown pool ${pool}`) };
  }

  const cutoff = tip - CUTOFF_LEDGERS;
  const cursor = params.pagination?.cursor ?? null;
  const startLedger = params.startLedger ?? (cursor ? null : registered.genesis_ledger);

  // Handoff: the requested range is already inside the RPC's retention window,
  // so the wallet's own RPC can and should serve it. Same signal as theirs.
  if (startLedger != null && startLedger >= cutoff) {
    return { error: rpcError(RETENTION_HANDOFF_CODE, "Continue syncing on your RPC endpoint", {
      reason: "retention_threshold",
      fromLedger: cutoff,
    }) };
  }

  // The archive serves from the request up to its own caught-up point, never
  // into the retention window (that is the handoff's job). Where the archive tip
  // trails the cutoff, the archive is simply still catching up — legitimate, not
  // a miss. A miss is only for a range the caller EXPLICITLY asked for and the
  // archive does not fully hold.
  const from = startLedger ?? registered.genesis_ledger;
  const coverageTop = coverageTopLedger(store, pool, registered.genesis_ledger);
  const effectiveTo = params.endLedger ?? coverageTop;
  const to = Math.min(effectiveTo, cutoff - 1);
  const after = cursor ?? "";

  // A requested range the archive has not fully covered is a cache miss, not a
  // silent empty page — the wallet must not mistake "not indexed yet" for
  // "nothing happened".
  const gaps = store.gaps(pool, to).filter((g) => g.from != null && g.from <= to && g.to >= from);
  if (gaps.length) {
    return { error: rpcError(CACHE_MISS_CODE, "cache miss; indexer may still be catching up", {
      missing: gaps.map((g) => ({ from: g.from, to: g.to })),
    }) };
  }

  const limit = Math.min(params.pagination?.limit ?? 200, 2000);
  const rows = store.eventsInRange(pool, from, to, after, limit);
  const events = rows.map((r) => toSorobanEvent(pool, r));
  const nextCursor = rows.length === limit ? rows[rows.length - 1].eventId : null;

  return {
    result: {
      events,
      latestLedger: tip,
      cursor: nextCursor,
    },
  };
}

// getCoverage — NOT in Nethermind's bootnode. The completeness proof for the
// served range, so a wallet can verify this archive did not omit or censor
// before it trusts a single event from it. This is the cryptographic answer to
// the "selective omission" attack vector their own docs enumerate.
export function getCoverageResult(store, tip, params) {
  const pool = firstContractId(params) ?? params.contractId;
  if (!pool) return { error: rpcError(INVALID_PARAMS_CODE, "a contractId is required") };
  const registered = store.pools().find((p) => p.pool === pool);
  if (!registered) return { error: rpcError(INVALID_PARAMS_CODE, `unknown pool ${pool}`) };
  // Completeness is measured from genesis to the ARCHIVE tip (its caught-up
  // point), not the chain tip: the archive is meant to trail the tip and hand
  // off the recent window to the wallet's RPC. "Complete" means no holes in what
  // the archive claims to hold, which is the property a wallet must verify.
  const archiveTip = coverageTopLedger(store, pool, registered.genesis_ledger);
  const gaps = store.gaps(pool, archiveTip);
  return {
    result: {
      genesis: registered.genesis_ledger,
      archiveTip,
      chainTip: tip,
      coverage: store.coverage(pool),
      gaps,
      complete: gaps.length === 0,
    },
  };
}

// The archive's caught-up point: the top of its highest coverage span, or
// genesis if it has none yet.
function coverageTopLedger(store, pool, genesis) {
  const cov = store.coverage(pool);
  return cov.length ? cov[cov.length - 1].to_ledger : genesis;
}

function firstContractId(params) {
  const filters = params?.filters ?? [];
  for (const f of filters) {
    const ids = f.contractIds ?? f.contract_ids ?? (f.contractId ? [f.contractId] : []);
    if (ids.length) return ids[0];
  }
  return params?.contractId ?? null;
}

// Dispatch one JSON-RPC request object to the matching handler. Pure: takes the
// store, the tip, and the request; returns a JSON-RPC response object.
export function dispatch(store, tip, req) {
  const id = req?.id ?? null;
  const reply = (payload) => ({ jsonrpc: "2.0", id, ...payload });

  const handlers = {
    getLatestLedger: () => ({ result: getLatestLedgerResult(store, tip) }),
    getEvents: () => getEventsResult(store, tip, req.params ?? {}),
    getCoverage: () => getCoverageResult(store, tip, req.params ?? {}),
  };

  const handler = handlers[req?.method];
  if (!handler) return reply({ error: rpcError(METHOD_NOT_FOUND_CODE, `method not found: ${req?.method}`) });
  return reply(handler());
}

export const BOOTNODE_METHODS = ["getEvents", "getLatestLedger", "getCoverage"];
export { CUTOFF_LEDGERS, RETENTION_HANDOFF_CODE, CACHE_MISS_CODE };

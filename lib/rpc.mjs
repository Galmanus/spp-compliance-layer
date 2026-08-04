// The Soroban RPC, and the one fact this whole project exists because of.
//
// `getEvents` serves a sliding window of roughly seven days. Ask for anything
// older and it does not degrade gracefully — it refuses, and helpfully tells
// you the window it is willing to serve:
//
//   startLedger must be within the ledger range: 3844914 - 3965873
//
// For a privacy pool that is not an inconvenience, it is a loss of funds. A
// wallet finds its own notes by trial-decrypting every `NewCommitmentEvent`
// ever emitted; the contract's own comment says so. Miss the history and the
// notes are unspendable, because the wallet cannot prove what it owns.

const DEFAULT_RPC = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

/** One JSON-RPC round trip, with the error surfaced rather than swallowed. */
async function call(method, params, { url = DEFAULT_RPC, timeoutMs = 30_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, { http: res.status });
    const body = await res.json();
    if (body.error) {
      throw new RpcError(`${method}: ${body.error.message ?? "unknown error"}`, {
        code: body.error.code,
        raw: body.error,
      });
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export class RpcError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "RpcError";
    Object.assign(this, meta);
  }

  /**
   * True when the RPC refused because the requested start is older than its
   * retention. This is the error the entire project is a response to, so it is
   * detected explicitly rather than lumped in with transport failures — a
   * caller must be able to tell "the network is down" from "this history no
   * longer exists anywhere".
   */
  get isOutsideRetention() {
    return /startLedger must be within the ledger range/i.test(this.message);
  }

  /** The window the RPC admitted to serving, parsed from its own message. */
  get retentionWindow() {
    const m = this.message.match(/ledger range:\s*(\d+)\s*-\s*(\d+)/i);
    return m ? { oldest: Number(m[1]), latest: Number(m[2]) } : null;
  }
}

export async function getLatestLedger(opts) {
  const r = await call("getLatestLedger", undefined, opts);
  return { sequence: r.sequence, protocolVersion: r.protocolVersion };
}


/**
 * One page of contract events. Returns the raw RPC shape plus the cursor to
 * continue from; decoding is the caller's business.
 *
 * `startLedger` and `cursor` are mutually exclusive in the RPC — passing both
 * is an error, so this takes one or the other.
 */
export async function getEvents({ startLedger, cursor, contractIds, limit = 200 }, opts) {
  const filters = [{ type: "contract" }];
  if (contractIds?.length) filters[0].contractIds = contractIds;

  const pagination = { limit };
  if (cursor) pagination.cursor = cursor;

  const params = { filters, pagination, xdrFormat: "json" };
  if (!cursor) params.startLedger = startLedger;

  const r = await call("getEvents", params, opts);
  return {
    events: r.events ?? [],
    cursor: r.cursor ?? null,
    latestLedger: r.latestLedger,
    // The RPC volunteers its retention floor on every answer. Carried through
    // rather than dropped: it is not diagnostics, it is the number that says
    // whether the history this index holds still exists anywhere else.
    oldestLedger: r.oldestLedger,
    latestLedgerCloseTime: r.latestLedgerCloseTime ? Number(r.latestLedgerCloseTime) : undefined,
    oldestLedgerCloseTime: r.oldestLedgerCloseTime ? Number(r.oldestLedgerCloseTime) : undefined,
  };
}

/**
 * The retention window as a measurement, with its span in days taken from the
 * ledgers' own close times rather than from "about five seconds each".
 *
 * One request, no error provoked. The refusal path still exists in `RpcError`
 * for the case that matters — a caller asking for history that is already gone
 * deserves to be told that, not handed an empty page.
 */
export async function measureRetention(opts) {
  // The RPC rejects a query with no anchor, so anchor on the newest ledger:
  // always inside the window, and the response carries the floor regardless of
  // where the query started.
  const { sequence } = await getLatestLedger(opts);
  const r = await getEvents({ startLedger: sequence, limit: 1 }, opts);
  const ledgers = r.latestLedger - r.oldestLedger;
  const seconds =
    r.latestLedgerCloseTime && r.oldestLedgerCloseTime
      ? r.latestLedgerCloseTime - r.oldestLedgerCloseTime
      : null;
  return {
    oldestLedger: r.oldestLedger,
    latestLedger: r.latestLedger,
    ledgers,
    days: seconds !== null ? seconds / 86_400 : (ledgers * 5) / 86_400,
    measuredCloseTimes: seconds !== null,
  };
}

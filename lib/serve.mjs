// The read API a wallet points at.
//
// The brief's indexer line is "a durable event index other builders can point a
// wallet AT" — the operative word is "point at", which means HTTP, not reaching
// into someone else's SQLite file. This is that surface: small, read-only, and
// shaped around the one thing a privacy wallet actually does — scan every
// commitment in order and check nullifiers.
//
// Dependency-free (Node's own http), because an indexer other people run should
// not drag a framework in, and because the endpoints are few enough that a
// router would be more code than the routes.

import { createServer } from "node:http";
import { openStore } from "./store.mjs";
import { measureRetention, getLatestLedger } from "./rpc.mjs";
import { dispatch, BOOTNODE_METHODS } from "./bootnode.mjs";

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1 << 20) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function serve(port = 8787, dbPath) {
  const store = openStore(dbPath);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      // POST / (or /rpc) — the bootnode JSON-RPC surface Nethermind's own client
      // speaks (getEvents, getLatestLedger) plus getCoverage. This is what makes
      // the index a drop-in, verifiable bootnode: point their unmodified
      // `bootnode_url` here and it serves the pre-retention history with a
      // completeness proof theirs cannot offer.
      if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/rpc")) {
        const raw = await readBody(req);
        let reqObj;
        try {
          reqObj = JSON.parse(raw);
        } catch {
          return json(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        }
        // The full retention envelope the client's GetEventsResponse requires,
        // read from the live RPC so the served window's bounds are real.
        const ret = await measureRetention();
        const ctx = {
          tip: ret.latestLedger,
          protocolVersion: ret.protocolVersion,
          retention: {
            oldestLedger: ret.oldestLedger,
            latestLedgerCloseTime: ret.latestLedgerCloseTime,
            oldestLedgerCloseTime: ret.oldestLedgerCloseTime,
          },
        };
        const batch = Array.isArray(reqObj) ? reqObj : [reqObj];
        const out = batch.map((r) => dispatch(store, ctx, r));
        return json(res, 200, Array.isArray(reqObj) ? out : out[0]);
      }

      // GET /rpc/methods — the bootnode surface, so a wallet can discover it
      if (req.method === "GET" && url.pathname === "/rpc/methods") {
        return json(res, 200, { methods: BOOTNODE_METHODS });
      }

      // GET /health — is the index alive, and how close to losing history
      if (req.method === "GET" && url.pathname === "/health") {
        const [{ sequence: tip }, ret] = await Promise.all([
          getLatestLedger(),
          measureRetention(),
        ]);
        const pools = store.pools().map((p) => ({
          pool: p.pool,
          label: p.label,
          genesis: p.genesis_ledger,
          ...store.counts(p.pool),
          gaps: store.gaps(p.pool, tip).length,
          daysToGenesisLoss: (p.genesis_ledger - ret.oldestLedger) * 5 / 86_400,
        }));
        return json(res, 200, { tip, retention: ret, pools });
      }

      // GET /pools — what this index is tracking
      if (req.method === "GET" && url.pathname === "/pools") {
        return json(res, 200, { pools: store.pools() });
      }

      // GET /pool/:id/commitments?after=<index> — the scan feed, in tree order
      if (req.method === "GET" && parts[0] === "pool" && parts[2] === "commitments") {
        const after = Number(url.searchParams.get("after") ?? -1);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 2000);
        return json(res, 200, { commitments: store.commitmentsFrom(parts[1], after, limit) });
      }

      // GET /pool/:id/nullifiers?after=<ledger>
      if (req.method === "GET" && parts[0] === "pool" && parts[2] === "nullifiers") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), 5000);
        return json(res, 200, { nullifiers: store.nullifiersFrom(parts[1], after, limit) });
      }

      // GET /pool/:id/spent/:nullifier — the one boolean a spend check needs
      if (req.method === "GET" && parts[0] === "pool" && parts[2] === "spent") {
        return json(res, 200, { spent: store.isSpent(parts[1], parts[3]) });
      }

      // GET /pool/:id/asp-roots — the root history, for attestation or audit
      if (req.method === "GET" && parts[0] === "pool" && parts[2] === "asp-roots") {
        return json(res, 200, { steps: store.aspRootSteps(parts[1]) });
      }

      // GET /pool/:id/coverage — the completeness proof, exposed so a wallet can
      // decide whether to trust this index before scanning it
      if (req.method === "GET" && parts[0] === "pool" && parts[2] === "coverage") {
        const { sequence: tip } = await getLatestLedger();
        return json(res, 200, {
          coverage: store.coverage(parts[1]),
          gaps: store.gaps(parts[1], tip),
        });
      }

      return json(res, 404, { error: "not found", routes: [
        "/health", "/pools",
        "/pool/:id/commitments?after=", "/pool/:id/nullifiers?after=",
        "/pool/:id/spent/:nullifier", "/pool/:id/asp-roots", "/pool/:id/coverage",
      ] });
    } catch (err) {
      // Log the detail server-side; return a generic message to the caller.
      // err.message can carry SQLite internals or filesystem paths, which a
      // read-only public endpoint has no business leaking.
      console.error(`[serve] ${req.method} ${req.url} failed:`, err);
      return json(res, 500, { error: "internal error" });
    }
  });

  server.listen(port, () => {
    console.log(`serving on http://localhost:${port}`);
    console.log("  a wallet scans /pool/:id/commitments and checks /pool/:id/spent/:nullifier");
    console.log("  /pool/:id/coverage exposes the completeness proof, so trust is checkable");
  });
  return server;
}

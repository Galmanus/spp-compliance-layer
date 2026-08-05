// Durable storage, and the accounting that makes the durability checkable.
//
// An index that stores events is easy. An index a wallet can TRUST is one that
// can answer "is anything missing?" — because a wallet that scans an
// incomplete history does not fail loudly, it silently fails to find a note
// and concludes it owns nothing. Silent undercounting is the failure mode that
// matters here, so coverage is tracked as data rather than assumed from the
// absence of errors.
//
// Coverage is stored as closed ledger intervals. Every successful ingest
// records the exact span it observed, adjacent spans merge, and a gap between
// them is a hole in the history that `audit` reports rather than hides.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commitments (
  pool           TEXT NOT NULL,
  commitment     TEXT NOT NULL,
  leaf_index     INTEGER,
  encrypted_output TEXT,
  ledger         INTEGER NOT NULL,
  tx_hash        TEXT,
  event_id       TEXT NOT NULL,
  PRIMARY KEY (pool, event_id)
);
CREATE INDEX IF NOT EXISTS commitments_by_ledger ON commitments(pool, ledger);
CREATE INDEX IF NOT EXISTS commitments_by_index  ON commitments(pool, leaf_index);

CREATE TABLE IF NOT EXISTS nullifiers (
  pool       TEXT NOT NULL,
  nullifier  TEXT NOT NULL,
  ledger     INTEGER NOT NULL,
  tx_hash    TEXT,
  event_id   TEXT NOT NULL,
  PRIMARY KEY (pool, event_id)
);
CREATE INDEX IF NOT EXISTS nullifiers_by_ledger ON nullifiers(pool, ledger);
CREATE INDEX IF NOT EXISTS nullifiers_by_value  ON nullifiers(pool, nullifier);

-- Closed intervals [from_ledger, to_ledger] this index has actually observed.
-- The whole trustworthiness argument rests on this table.
CREATE TABLE IF NOT EXISTS coverage (
  pool        TEXT NOT NULL,
  from_ledger INTEGER NOT NULL,
  to_ledger   INTEGER NOT NULL,
  PRIMARY KEY (pool, from_ledger)
);

-- ASP LeafAddedEvent(leaf, index, root): the append-only root history the
-- Layer-3 attestation proves a chain over. Its own table rather than the
-- commitment table, because it is its own event with its own fields.
CREATE TABLE IF NOT EXISTS asp_roots (
  pool       TEXT NOT NULL,
  leaf       TEXT NOT NULL,
  leaf_index INTEGER NOT NULL,
  root       TEXT NOT NULL,
  ledger     INTEGER NOT NULL,
  event_id   TEXT NOT NULL,
  PRIMARY KEY (pool, event_id)
);
CREATE INDEX IF NOT EXISTS asp_roots_by_index ON asp_roots(pool, leaf_index);

CREATE TABLE IF NOT EXISTS pools (
  pool            TEXT PRIMARY KEY,
  genesis_ledger  INTEGER NOT NULL,
  label           TEXT,
  first_indexed_at TEXT
);

-- Every observation of the RPC's retention floor, kept as a series. The window
-- slides, and a wallet operator deserves to see it sliding rather than take
-- our word that it does.
CREATE TABLE IF NOT EXISTS retention_observations (
  observed_at   TEXT NOT NULL,
  floor_ledger  INTEGER NOT NULL,
  latest_ledger INTEGER NOT NULL,
  PRIMARY KEY (observed_at)
);
`;

export function openStore(path = process.env.NOTEWATCH_DB ?? "data/notewatch.db") {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  registerPool(pool, genesisLedger, label) {
    this.db
      .prepare(
        `INSERT INTO pools (pool, genesis_ledger, label, first_indexed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pool) DO UPDATE SET genesis_ledger = excluded.genesis_ledger,
                                         label = excluded.label`
      )
      .run(pool, genesisLedger, label ?? null, new Date().toISOString());
  }

  pools() {
    return this.db.prepare(`SELECT * FROM pools ORDER BY pool`).all();
  }

  recordRetention(floorLedger, latestLedger) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO retention_observations (observed_at, floor_ledger, latest_ledger)
         VALUES (?, ?, ?)`
      )
      .run(new Date().toISOString(), floorLedger, latestLedger);
  }

  retentionHistory(limit = 50) {
    return this.db
      .prepare(`SELECT * FROM retention_observations ORDER BY observed_at DESC LIMIT ?`)
      .all(limit);
  }

  /**
   * Write a batch and extend coverage atomically. Either the events and the
   * claim that we have them both land, or neither does — a coverage record
   * without its events would be a lie the audit could not catch.
   */
  ingestBatch(pool, { commitments = [], nullifiers = [], fromLedger, toLedger }) {
    const insC = this.db.prepare(
      `INSERT OR IGNORE INTO commitments
         (pool, commitment, leaf_index, encrypted_output, ledger, tx_hash, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insN = this.db.prepare(
      `INSERT OR IGNORE INTO nullifiers (pool, nullifier, ledger, tx_hash, event_id)
       VALUES (?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      let added = 0;
      for (const c of commitments) {
        added += insC.run(
          pool, c.commitment, c.leafIndex ?? null, c.encryptedOutput ?? null,
          c.ledger, c.txHash ?? null, c.eventId
        ).changes;
      }
      for (const n of nullifiers) {
        added += insN.run(pool, n.nullifier, n.ledger, n.txHash ?? null, n.eventId).changes;
      }
      if (Number.isInteger(fromLedger) && Number.isInteger(toLedger) && toLedger >= fromLedger) {
        this.#extendCoverage(pool, fromLedger, toLedger);
      }
      return added;
    });
    return tx();
  }

  /** Merge [from, to] into the coverage set, coalescing anything it touches. */
  #extendCoverage(pool, from, to) {
    const overlapping = this.db
      .prepare(
        `SELECT from_ledger, to_ledger FROM coverage
         WHERE pool = ? AND to_ledger >= ? - 1 AND from_ledger <= ? + 1`
      )
      .all(pool, from, to);

    let lo = from;
    let hi = to;
    for (const r of overlapping) {
      lo = Math.min(lo, r.from_ledger);
      hi = Math.max(hi, r.to_ledger);
      this.db.prepare(`DELETE FROM coverage WHERE pool = ? AND from_ledger = ?`)
        .run(pool, r.from_ledger);
    }
    this.db.prepare(`INSERT INTO coverage (pool, from_ledger, to_ledger) VALUES (?, ?, ?)`)
      .run(pool, lo, hi);
  }

  coverage(pool) {
    return this.db
      .prepare(`SELECT from_ledger, to_ledger FROM coverage WHERE pool = ? ORDER BY from_ledger`)
      .all(pool);
  }

  /**
   * The question a wallet actually needs answered: between the pool's genesis
   * and `throughLedger`, what have we NOT seen? Returns the gaps. An empty
   * array is the only acceptable answer for a wallet that intends to trust its
   * own balance.
   */
  gaps(pool, throughLedger) {
    const row = this.db.prepare(`SELECT genesis_ledger FROM pools WHERE pool = ?`).get(pool);
    if (!row) return [{ from: null, to: null, reason: "pool not registered" }];

    const spans = this.coverage(pool);
    const gaps = [];
    let cursor = row.genesis_ledger;
    for (const s of spans) {
      if (s.from_ledger > cursor) gaps.push({ from: cursor, to: s.from_ledger - 1 });
      cursor = Math.max(cursor, s.to_ledger + 1);
    }
    if (cursor <= throughLedger) gaps.push({ from: cursor, to: throughLedger });
    return gaps;
  }

  counts(pool) {
    const c = this.db.prepare(`SELECT COUNT(*) n FROM commitments WHERE pool = ?`).get(pool).n;
    const n = this.db.prepare(`SELECT COUNT(*) n FROM nullifiers WHERE pool = ?`).get(pool).n;
    return { commitments: c, nullifiers: n };
  }

  /**
   * The scan feed a wallet consumes: commitments in tree order, from a cursor.
   * Ordered by leaf index rather than ledger, because that is the order the
   * Merkle tree grew in and the order a wallet must rebuild it.
   */
  commitmentsFrom(pool, afterIndex = -1, limit = 500) {
    return this.db
      .prepare(
        `SELECT commitment, leaf_index AS leafIndex, encrypted_output AS encryptedOutput,
                ledger, tx_hash AS txHash
         FROM commitments
         WHERE pool = ? AND leaf_index > ?
         ORDER BY leaf_index ASC LIMIT ?`
      )
      .all(pool, afterIndex, limit);
  }

  /** Every nullifier seen, so a wallet can mark its own notes spent. */
  nullifiersFrom(pool, afterLedger = 0, limit = 1000) {
    return this.db
      .prepare(
        `SELECT nullifier, ledger, tx_hash AS txHash FROM nullifiers
         WHERE pool = ? AND ledger >= ? ORDER BY ledger ASC LIMIT ?`
      )
      .all(pool, afterLedger, limit);
  }

  isSpent(pool, nullifier) {
    return !!this.db
      .prepare(`SELECT 1 FROM nullifiers WHERE pool = ? AND nullifier = ?`)
      .get(pool, nullifier);
  }

  /** Record one ASP LeafAddedEvent. Idempotent on (pool, event_id). */
  ingestAspRoot(pool, { leaf, leafIndex, root, ledger, eventId }) {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO asp_roots (pool, leaf, leaf_index, root, ledger, event_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(pool, leaf, leafIndex, root, ledger, eventId).changes;
  }

  /**
   * The ASP root history in tree order, as the `(index, root)` steps the
   * Layer-3 attestation proves an append-only chain over. This is the seam
   * between the durable index and the post-quantum attestation: the index
   * remembers what the RPC forgets, and these rows are what the STARK proves is
   * honest.
   */
  aspRootSteps(pool) {
    return this.db
      .prepare(
        `SELECT leaf_index AS "index", root, ledger FROM asp_roots
         WHERE pool = ? ORDER BY leaf_index ASC`
      )
      .all(pool);
  }

  /**
   * Events in [fromLedger, toLedger], keyed for cursor paging. This is what a
   * bootnode-compatible `getEvents` serves: the raw events the RPC has forgotten,
   * in the same order and with the same paging discipline the wallet's sync loop
   * expects.
   *
   * Ordering and the cursor MUST agree, or a page boundary drops events. The
   * cursor is a Soroban paging token (`event_id`), which is globally monotone in
   * ledger order, so ordering by `event_id` alone is the canonical Stellar order
   * AND matches the `event_id > cursor` filter exactly. Ordering by
   * `(ledger, event_id)` instead would mismatch the single-column cursor: a page
   * ending at `(L, "z")` would then skip a later `(L+1, "a")`, since `"a" > "z"`
   * is false. Ordering by the paging token removes that hazard.
   */
  eventsInRange(pool, fromLedger, toLedger, afterEventId = "", limit = 200) {
    return this.db
      .prepare(
        `SELECT 'asp_root' AS kind, leaf_index AS leafIndex, leaf, root, ledger, event_id AS eventId
           FROM asp_roots
          WHERE pool = ? AND ledger >= ? AND ledger <= ? AND event_id > ?
          UNION ALL
         SELECT 'commitment' AS kind, leaf_index AS leafIndex, commitment AS leaf, NULL AS root, ledger, event_id AS eventId
           FROM commitments
          WHERE pool = ? AND ledger >= ? AND ledger <= ? AND event_id > ?
          ORDER BY eventId ASC
          LIMIT ?`
      )
      .all(pool, fromLedger, toLedger, afterEventId, pool, fromLedger, toLedger, afterEventId, limit);
  }
}

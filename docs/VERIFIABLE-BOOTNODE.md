# A verifiable bootnode

## The component this project completes

Stellar RPC serves contract events for only about seven days. A private-payment
wallet rebuilds its balance by scanning every commitment event from a pool's
deployment ledger forward, so a wallet that was offline longer than the window,
or is onboarding fresh, cannot rebuild from the RPC alone.

Nethermind's SPP client already handles this. On the retention refusal it hands
sync off to an optional archive:

- `sdk/client/src/sync.rs:311` — `is_retention_handoff` detects the exact RPC
  refusal (`"startLedger must be within the ledger range"`).
- `sdk/client/src/sync.rs:298` — on that signal, sync continues against a
  configured `bootnode_url` "until retention handoff, then clear cursors for
  main RPC resume."

Nethermind also ships the archive itself — `tools/bootnode`, documented in
`docs/src/bootnode.md`. So the retention problem is not an undiscovered bug, and
this project does not claim it is. What the reference bootnode leaves open is
**trust**. Its own documentation says so.

## The trust risks Nethermind's bootnode documents as open

From `docs/src/bootnode.md`, "Trust assumptions" and "Attack vectors"
(quoted verbatim):

- (`bootnode.md:41`) "Integrity risk: the bootnode can serve incorrect history,
  omit events, or selectively censor data."
- (`bootnode.md:44`) "Handoff integrity risk: a malicious bootnode could return
  an incorrect `fromLedger`, causing the indexer to skip or replay the wrong
  ledger range on the main RPC."
- (`bootnode.md:50`) "Serve a forged event history that causes an incorrect
  local reconstruction."
- (`bootnode.md:52`) "Censor specific contract IDs/events (selective omission)."
- (`bootnode.md:54`) "Signal a misleading `fromLedger` at handoff to steer
  catch-up onto the wrong ledger range."

The only mitigation the document offers for these (`bootnode.md:60`): "Users who
need stronger trust guarantees should self-host a bootnode and/or cross-check
history using multiple RPC providers." That is an operational check, not a
cryptographic one. A wallet still has to trust that the archive it read did not
omit or reorder a single event.

## What this project adds, one attack vector at a time

This bootnode speaks the same JSON-RPC surface their client already talks to —
`getEvents` (map params), `getLatestLedger`, the `-32002` retention handoff and
`-32004` cache-miss, matching `tools/bootnode/src/rpc.rs` — so an unmodified SPP
client can point `bootnode_url` at it.

The compatibility is not asserted, it is proven against their own struct. Their
client deserializes `getEvents` into `GetEventsResponse` /`Event`
(`sdk/stellar/src/rpc.rs:112`), whose `topic: Vec<String>` and `value: String`
are base64-XDR ScVals — the default RPC format, since their `RpcClient` does not
request `xdrFormat:"json"`. This bootnode returns exactly that: every response
field present with the serde-correct type, and each event's topic/value is
canonical XDR. `test/conformance.test.mjs` decodes each served event through
`@stellar/stellar-base` (the same codec) and checks it yields the native
`{index, leaf, root}` the wallet expects; `test/scval-xdr.test.mjs` asserts the
dependency-free encoder is byte-identical to that SDK. The history it serves is
also provable:

| Attack vector (their `bootnode.md`) | Cryptographic mitigation here | Where |
|:--|:--|:--|
| Selective omission / censor events (`:41`, `:52`) | **The core mitigation.** `getCoverage` returns the coverage-interval completeness proof from genesis; an omitted ledger is a reported gap, so silent omission becomes a visible, checkable hole. | `lib/bootnode.mjs` `getCoverageResult`, `lib/store.mjs` `gaps()` |
| Serve a forged root history (`:50`) | The Layer-3 Circle-STARK adds a **post-quantum proof of the append-only index structure** (gap-free indices, endpoints pinned to public values) over the served roots. It witnesses the roots rather than re-deriving them, so it proves the *shape* against endpoints a verifier knows independently — not that the roots are legitimate; that binding is the coverage proof's job (row above). Stated precisely, not overclaimed. | `attestation/`, `docs/LAYER3-DESIGN.md` |
| Misleading `fromLedger` at handoff (`:44`, `:54`) | The handoff `fromLedger` is bounded by proven-contiguous coverage from genesis; a wallet can verify the archive actually held everything below the handoff point before trusting it. | `lib/bootnode.mjs` `getEventsResult`, `getCoverage` |
| Incorrect local reconstruction (`:50`) | The primitives whose events are served were audited by execution, not inference — 15 probes run against the deployed WASM. | `docs/audit/sorohunter-spp-pool.md` |

The reference bootnode's integrity rests on running several and comparing. This
one's rests on a proof the wallet checks once. Disanalogy: cross-checking
multiple providers also resists an availability failure that a single verifiable
archive does not — a proof does not help if the one archive holding it is down.
The two approaches compose; they are not substitutes. The honest claim is
narrower and stronger: this closes the **integrity** gap their document names,
not the availability one.

## Honest limits

- The append-only attestation proves the STRUCTURE of the root history (indices
  `0,1,2,…` with no gap, witnessed roots, endpoints pinned). It treats each
  BN254-Poseidon2 root as a witnessed label; it does not re-derive the hash
  inside the M31 STARK. Reproving a pairing-field hash in a Mersenne-31 field is
  out of scope, and stated so in `attestation/src/main.rs`.
- `getCoverage` proves the archive did not omit within what it claims to hold. It
  cannot prove the archive saw an event that never reached its own RPC feed; the
  completeness claim is relative to the deployment-ledger genesis it started
  from, which is why genesis is pinned per pool.
- Today the demo pool's events are young enough that the main RPC still serves
  them, so `getEvents` correctly returns the `-32002` handoff rather than
  serving. The serve path is exercised in `test/bootnode.test.mjs` and
  `test/conformance.test.mjs` against a genuinely pre-retention pool. The same
  live request flips to served events once the window slides past the pool's
  genesis.
- `ledgerClosedAt` is the one event field not reconstructed: the index did not
  capture per-ledger close times, and their client stores the field as a String
  without keying sync on it, so it is returned empty. Every other field is
  reconstructed exactly. Capturing close times is a one-line ingest change if a
  consumer needs them.

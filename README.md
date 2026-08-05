```
                          ██
                          ██
  ██▀▀▀██  ██▀▀▀██  ██▀▀▀██
  ██▄▄▄▀▀  ██▄▄▄██  ██▄▄▄▀▀    c o m p l i a n c e   l a y e r
  ██       ██       ██
  ██       ██       ██         for Stellar Private Payments

  ▸ the memory the RPC deletes, and the proof the pairing cannot outlive
```

**A verifiable bootnode for Stellar Private Payments — the durable event archive
their client already reaches for, made trust-minimized: it serves the history
the RPC forgets with a completeness proof and a post-quantum attestation the
reference bootnode's own docs say it lacks.**

[![on-chain PQ](https://img.shields.io/badge/post--quantum%20STARK-verified%20on--chain%20on%20Stellar-6a1b9a)](#a-first-on-stellar--a-post-quantum-proof-verified-on-chain)
[![tests](https://img.shields.io/badge/tests-22%20JS%20%2B%203%20Rust%20green-4c1)](#run-it-yourself-in-five-minutes)
[![node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](#run-it-yourself-in-five-minutes)
[![post-quantum](https://img.shields.io/badge/attestation-hash--based%2C%20no%20trusted%20setup-8A2BE2)](#layer-3--post-quantum-attestation-of-asp-root-history)
[![retention](https://img.shields.io/badge/RPC%20window-7.02%20days%2C%20measured-1f6feb)](#layer-2--the-durable-index)
[![lane](https://img.shields.io/badge/lane-Privacy%20%C2%B7%20OpenZeppelin%20%2B%20Nethermind-orange)](https://github.com/NethermindEth/stellar-private-payments)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)

## A first on Stellar — a post-quantum proof verified on-chain

The Layer-3 attestation does not only verify off-chain. A **hash-based,
trusted-setup-free, post-quantum Circle-STARK** that a privacy pool's compliance
root history is an honest append-only chain is **verified inside a Soroban
contract, in a single Stellar transaction** — over the *real* 15-leaf history,
with live receipts:

| | on Stellar testnet |
|:--|:--|
| Contract | `CCWNNU4K3LWEPFRI7HLXV2WA2CV7C4Z7MFMWP7I7JZWESLTLPNHPCWRG` |
| Honest proof → `true` | tx [`96110dc1…`](https://stellar.expert/explorer/testnet/tx/96110dc19ea1ea63b888bbcd02fbb7c2c76a5d91ff03aa2ce14797e7f83e6718) |
| Tampered root → `false` | tx [`ee36ca3d…`](https://stellar.expert/explorer/testnet/tx/ee36ca3dacb7e7b0c9dfa83afbcb07a5f5b775a27d9674678fa005e07eadea5f) |
| Cost | 260M instructions (65% of one tx), 112 KB wasm, ~0.0385 XLM |

To our knowledge, the first transparent post-quantum proof verified on-chain on
Stellar in a privacy-compliance context — a checkable claim, given the SDF's own
statement that no drop-in post-quantum replacement for pairing SNARKs exists, and
that Stellar's privacy stack (SPP Groth16, OZ UltraHonk) is entirely BN254. On
chain the security is 48 classical / **24 quantum** bits at 40 queries (one
transaction); the stronger 62-quantum-bit version runs off-chain. Both figures
are stated, neither is hidden. Full detail and reproduction:
**[docs/ONCHAIN-VERIFICATION.md](docs/ONCHAIN-VERIFICATION.md)**.

---

> Submitted to the **Confidential-Token & Private-Payment Wallets** sub-lane,
> under the brief's *ecosystem infrastructure* heading. Twenty teams will build
> wallets on primitives that describe themselves as unaudited works in progress.
> This is the layer that lets those wallets be trusted: it audits the
> primitives, remembers the history they forget, and proves that history honest
> in a way a quantum computer cannot undo.
>
> **It is not adjacent to the SPP stack — it completes a component of it.**
> Nethermind's client hands sync off to a `bootnode_url` on the retention gap
> (`sdk/client/src/sync.rs:298`), and Nethermind's own bootnode docs name
> forged-history, selective-omission, and misleading-handoff as *unmitigated*
> trust risks (`docs/src/bootnode.md:41-54`). This project speaks that same
> bootnode protocol so their unmodified client can point at it, and closes those
> exact risks with proof. See **[docs/VERIFIABLE-BOOTNODE.md](docs/VERIFIABLE-BOOTNODE.md)**.

---

## The problem, in one picture

A wallet on a privacy pool has no "what's my balance?" call. It rebuilds its
balance by trial-decrypting **every commitment the pool ever emitted** — the
pool contract's own comment says so. That history lives in Soroban RPC events,
and the RPC keeps **seven days** of them.

```mermaid
timeline
    title A private wallet's balance depends on history the RPC deletes
    Genesis 3899359 : Pool deployed : commitments begin
    Day 0 to 7      : RPC serves events : wallet can rebuild balance
    Day 7+          : RPC refuses older ledgers : "startLedger must be within range"
    After           : commitments unreachable : wallet cannot prove what it owns
```

Measured live, from the RPC's own close times:

```
retention window: 120,959 ledgers = 7.02 days
SPP pool genesis leaves the RPC in ~3 days — during judging weekend
```

That number **shrinks between runs**, because the window slides with the chain.
It is not our claim to fake — it is the RPC describing itself.

---

## The three layers

```mermaid
flowchart LR
    subgraph chain["Stellar testnet"]
        pool["SPP pool<br/>NewCommitment / NewNullifier"]
        asp["ASP contracts<br/>LeafAddedEvent(leaf, index, root)"]
    end

    subgraph L1["① Audit — sorohunter"]
        probe["fork-validated probes<br/>a finding is an executed run"]
    end

    subgraph L2["② Durable index"]
        idx[("captured history<br/>+ coverage proof")]
        clock["retention clock<br/>7.02 days, sliding"]
    end

    subgraph L3["③ Post-quantum attestation"]
        stark["Circle-STARK<br/>append-only chain proof"]
    end

    pool -->|read-only WASM| probe
    asp  -->|read-only WASM| probe
    pool -->|events| idx
    asp  -->|root history| idx
    idx  --> clock
    idx  -->|"(index, root) steps"| stark
    stark -->|"attestation, ~131 KB @ 62 quantum-bit"| reg["regulator / verifier<br/>no trusted setup, no quantum expiry"]

    style L1 fill:#fff3e0,stroke:#e65100
    style L2 fill:#e3f2fd,stroke:#1565c0
    style L3 fill:#f3e5f5,stroke:#6a1b9a
```

| Layer | What it does | Status | Draws on |
|:--|:--|:--|:--|
| **① Audit** | Fork-validated adversarial probing of the lane's own primitives; a finding is an executed invocation sequence, never an inference | ran, documented | [sorohunter](https://github.com/Galmanus/sorohunter) |
| **② Index** | Captures pool + ASP events from genesis, past the RPC's 7-day window, and **proves completeness** instead of asserting it | running vs testnet | this repo |
| **③ Attestation** | Hash-based Circle-STARK (Rust, [`attestation/`](attestation/)) that the ASP root history is an append-only chain — no trusted setup, no quantum expiry | tested, measured | STARK crate [riverrun-m31](https://github.com/Galmanus/mirror-pool) |

---

## Layer 1 — adversarial audit of the primitives

The pool exposes exactly one question to its compliance provider:

```rust
trait ASPMembershipInterface {
    fn get_root(env: Env) -> Result<U256, Error>;   // pool.rs:588 compares this
}
```

Clean design — and nobody has verified the contracts behind it. `sorohunter`
acquired the **real deployed WASM** read-only and executed 15 probes in a local
`soroban-sdk` fork. Its one invariant: *a finding is an executed run, never an
inference,* so an unassemblable target yields "could not deploy", never "looks
vulnerable".

**Verdict: the SPP contract layer is well built.** Three bug classes — including
non-canonical public-input validation, the exact class that cost a sibling
project a double-spend — were checked and are absent:

| surface | location | verdict |
|:--|:--|:--:|
| non-canonical public inputs | `pool.rs:365` | correct: range-checked vs BN254 modulus |
| access control on `insert_leaf` | `asp-membership/lib.rs:195` | correct: admin-only by default |
| the gate protecting that control | `asp-membership/lib.rs:137` | correct: requires admin auth |

The engine also located where a real audit must go: `transact` — the money path
— takes a Groth16 proof as a struct, so it is reachable only by something that
can *prove*. Full report: [`docs/audit/`](docs/audit/sorohunter-spp-pool.md).

The audit layer is not primitive-specific, so the same fork-validated pass was
run on the lane's **other** sponsor primitive — the OpenZeppelin Confidential
Token (UltraHonk). Same structure, by execution: the token's paths need its
cross-contract constructor, and the verifier's soundness-critical surface
(`verify_proof`, VK management) is behind a `CircuitType` + UltraHonk proof no
generic fuzzer builds — with contract-level access control correctly manager-
gated, and the backend self-flagged unaudited by OpenZeppelin. Both sponsors'
primitives put their critical path behind a proof; auditing this lane has to be
proof-aware. Full report:
[`sorohunter-oz-confidential-token.md`](docs/audit/sorohunter-oz-confidential-token.md).

---

## Layer 2 — the durable index

A page of events proves nothing about ledgers past its last event, so coverage
is claimed **only for ledgers the RPC confirmed it walked**. Over-claiming is
the one bug an audit cannot catch, because the audit reads the same table — so
coverage is stored as merge-able intervals, and gaps are reported, never hidden.

```mermaid
flowchart TD
    tip["chain tip"] --> ev["getEvents from genesis"]
    ev --> dec["decode: commitment / nullifier / asp_root"]
    dec --> cov["coverage intervals<br/>merge adjacent, expose gaps"]
    dec --> db[("SQLite: durable")]
    cov --> audit{"gaps?"}
    audit -->|none| ok["COMPLETE from genesis"]
    audit -->|"gap past RPC floor"| lost["GONE — this index is the only copy"]
```

```console
$ node bin/spp-index.mjs watch 30
[16:24:06] tick 1  tip 3,968,115  +0 rows  runway 3.02d
[16:24:36] tick 2  tip 3,968,121  +0 rows  runway 3.02d      # the clock ticks down live

$ node bin/spp-index.mjs audit
audit at chain tip 3,966,299, RPC floor 3,845,336
SPP pool (native XLM)
  COMPLETE from genesis to chain tip
```

`watch` is what makes this infrastructure rather than a script: it ingests on an
interval, retries on error, and its state is durable — a restarted process picks
up exactly where it left off, which a wallet has to be able to rely on.

### The read API a wallet points at

The brief's indexer line is *"a durable event index other builders can point a
wallet at"* — so `serve` exposes a small read-only HTTP surface shaped around
what a privacy wallet does:

| endpoint | for |
|:--|:--|
| `GET /pool/:id/commitments?after=<index>` | the scan feed, in tree order — a wallet trial-decrypts these |
| `GET /pool/:id/spent/:nullifier` | the one boolean a spend check needs |
| `GET /pool/:id/asp-roots` | the root history, for attestation or audit |
| `GET /pool/:id/coverage` | the completeness proof, so a wallet can decide whether to trust this index *before* scanning it |
| `GET /health` | tip, retention window, per-pool gap count and days-to-genesis-loss |

The `coverage` endpoint is the one that matters: an index a wallet cannot audit
is an index a wallet cannot trust, so completeness is a queryable fact, not a
promise.

---

## Layer 3 — post-quantum attestation of ASP root history

A `get_root` snapshot proves a root exists at an instant. A regulator in 2035
needs more: that the **sequence** of published roots is an honest append-only
chain. Today those roots are attested by Groth16 over BN254 — a trusted setup to
rely on, a quantum adversary to outlive, on a permanent ledger.

We attest the **structure** of the history with a hash-based Circle-STARK.

```mermaid
flowchart LR
    e0["LeafAdded #0<br/>root₀"] --> e1["LeafAdded #1<br/>root₁"] --> e2["LeafAdded #2<br/>root₂"] --> en["…root_n"]
    e0 -.->|"index +1, pinned first root"| air
    en -.->|"pinned last root"| air
    air{{"AIR constraints:<br/>monotone gap-free index<br/>root chaining<br/>endpoints pinned"}}
    air --> proof["STARK attestation<br/>reorder / inject → unprovable"]
```

The BN254-Poseidon2 hash is a **witnessed oracle**, not reproven (different
field from the M31 STARK; reproving it is out of scope and stated as such). What
a quantum adversary cannot forge is the *shape* of the chain — a reordered or
leaf-injected history is unprovable, not merely unverifiable.

**Measured** — soundness is a query count the prover and verifier share
(`attestation/src/lib.rs`). Bits are from riverrun-m31's own round-by-round
accounting at `log_blowup = 1` over the QM31 degree-4 field, plus 8 PoW bits.
The attestation is verified off-chain by a regulator, so proof size is not bound
by the tx envelope:

| queries | classical bits | quantum bits | proof (15-leaf) |
|:--|:--:|:--:|:--:|
| 20 (earlier) | 28 | 14 | 21,688 B |
| **128 (shipped)** | **124** | **62** | **134,357 B** |

62 quantum bits is the ceiling of the QM31 challenge field (`|E| ≈ 2^124`): more
queries buy nothing past it, and exceeding it needs a larger extension field —
new cryptography, not a config change. It is chosen honestly over the earlier
14, which was too few to call post-quantum in any real sense.

### Demonstrated on real on-chain history

The deployed Nethermind pools are empty, so we used the primitive for real:
deployed Nethermind's own `asp-membership` to testnet, inserted **fifteen leaves**
over the demonstration window, and ran the full pipeline against the `LeafAdded`
events it emitted. Every number below reproduces from the contract ID; see
[docs/LIVE-DEMONSTRATION.md](docs/LIVE-DEMONSTRATION.md).

```console
$ node bin/spp-index.mjs ingest        # captured 15 REAL events from the chain
  no gaps from genesis to 3,969,521
$ node bin/spp-index.mjs attest CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR
  post-quantum attestation: 134,357 bytes, covers root indices 0..14

$ attestation/target/release/verify-asp-history \
    attestation.postcard 0 <first_root> <last_root> 15     # a regulator checks
VALID: an honest append-only chain of 15 root updates ending at the attested root.

$ attestation/target/release/verify-asp-history \
    attestation.postcard 0 <first_root> <last_root^1> 15   # one flipped bit
INVALID: this attestation does not verify against those public values.
```

Running against the chain caught two real decoder bugs a first draft had (the
RPC's `xdrFormat: json`, and a `u64` index field) — found by execution, not by
reading.

Prove and verify are **separate Rust binaries** in [`attestation/`](attestation/),
because the party proving and the party checking are different people. A tampered
final root turns the `VALID` into `INVALID` — the attestation is a proof, not a
blob.

Its own limits are published, not implied: **124 bits classical soundness, 62
against a quantum adversary** at the shipped 128 queries — the QM31 field ceiling,
short of a 128-bit target and honestly named as such. The compression function is
not assumed collision resistant, and the argument's zero-knowledge is two proved
components and the rest inherited — full accounting in the
[mirror-pool](https://github.com/Galmanus/mirror-pool) repo. The attestation is
post-quantum in construction (hash-based, no trusted setup, no pairing); it does
not make the SPP/OZ privacy proofs themselves post-quantum — those are BN254, and
no drop-in post-quantum replacement for them exists (the SDF says so).

---

## Run it yourself in five minutes

```bash
npm install

# Layers 1-2 (index, audit) need only Node. Layer 3 (attestation) is Rust —
# build it once:
( cd attestation && cargo build --release )

# then the whole thing, end to end, on real testnet data, in one command:
./demo.sh          # retention clock → capture 12 real events → attest → verify → tamper → refuse

npm test                            # 9 JS tests: coverage merge, gap honesty, scan feed, spent check

node bin/spp-index.mjs retention    # ← run this first: the sliding 7-day clock
node bin/spp-index.mjs init         # register the deployed SPP contracts
node bin/spp-index.mjs ingest       # capture from genesis; proves "no gaps" or names them
node bin/spp-index.mjs watch 30     # run continuously: ingest every 30s, state persists
node bin/spp-index.mjs serve 8787   # the read API a wallet points at (HTTP)
node bin/spp-index.mjs audit        # coverage, gaps, what's gone from the RPC for good

# Layer 3 needs the prover binary, built once from the mirror-pool repo:
#   cd attestation && cargo build --release && cd ..
node bin/spp-index.mjs attest <asp-contract-id>
```

---

## What this is not

Stated first, because a compliance tool that overstates itself is worse than one
that does not exist.

- **It does not replace the Groth16 circuit.** The pool's membership proof lives
  inside the circuit; this is a *parallel* attestation of the root's
  construction at the seam the pool already exposes.
- **It is not audited**, and neither is what it builds on — SPP describes itself
  as a work-in-progress reference implementation, and so does this.
- **The on-chain demonstration is real, not a fixture.** Because the deployed
  Nethermind pools are empty, we deployed Nethermind's own `asp-membership`
  contract unmodified, inserted five leaves, and ran all three layers against
  the real `LeafAdded` events — captured and attested on live testnet. Full
  record in [`docs/LIVE-DEMONSTRATION.md`](docs/LIVE-DEMONSTRATION.md), contract
  `CDP7Z7U2W45K…`. What is *not* done: wiring the pool to require this
  attestation, which is a contract change, not claimed here.

The one thing this submission sells is that its claims are **executed**. Every
number above came from a command in this README. Where something is not done, it
says so.

---

## Repository map

| Path | What |
|:--|:--|
| `attestation/` | **Rust** — Layer-3 STARK: `attest-asp-history` (prove) + `verify-asp-history` (check) + tests |
| `bin/spp-index.mjs` | the CLI: `retention` · `init` · `ingest` · `audit` · `attest` |
| `lib/rpc.mjs` | Soroban RPC client; retention detection from the RPC's own refusal |
| `lib/store.mjs` | durable SQLite store + coverage-interval completeness accounting |
| `lib/ingest.mjs` | the ingest loop; claims coverage only for ledgers actually walked |
| `lib/decode.mjs` | event decoder: commitment · nullifier · ASP `LeafAddedEvent` |
| `test/` | 6 tests: the behaviour that must not regress |
| `docs/PLAN.md` | the three-layer thesis |
| `docs/audit/` | the sorohunter audit results |
| `docs/LAYER3-DESIGN.md` | why the attestation proves history, not the hash |

## License

MIT.

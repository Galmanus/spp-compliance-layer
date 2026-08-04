# spp-compliance-layer

**Compliance infrastructure for Stellar Private Payments that outlives both the
RPC's memory and the pairing it was built on.**

Submitted to the *Confidential-Token & Private-Payment Wallets* sub-lane
(Privacy · OpenZeppelin + Nethermind), under the brief's
**ecosystem infrastructure** heading.

---

## The two problems this is about

Nethermind's [Stellar Private Payments](https://github.com/NethermindEth/stellar-private-payments)
is a privacy pool with a compliance layer: Association Set Providers publish
Merkle roots, and a depositor proves membership in an approved set (or absence
from a blocked one) inside the Groth16 circuit. The pool contract itself only
asks the ASP one question:

```rust
trait ASPMembershipInterface {
    fn get_root(env: Env) -> Result<U256, Error>;
}
```

It compares that root against the one the prover named, and trusts the circuit
for the rest (`contracts/pool/src/pool.rs:588`).

That design is clean, and it leaves two holes that nobody has filled.

### 1. The history a wallet needs is deleted after seven days

A wallet finds its own notes by trial-decrypting **every** `NewCommitmentEvent`
the pool ever emitted — the contract's own comment says so: *"allows off-chain
observers to track new UTXOs and decrypt outputs intended for them."*

Soroban RPC does not keep that history. Ask for anything older and it refuses,
and tells you the window it is willing to serve:

```
startLedger must be within the ledger range: 3844914 - 3965873
```

Measured on 4 August 2026: **120,959 ledgers, almost exactly 7.0 days.**

For a public chain that is a retention policy. For a privacy pool it is a loss
of funds: a wallet that was offline for eight days cannot rebuild its own
balance, because the commitments it owns are no longer reachable from anywhere.

**And it is about to bite.** The testnet pool
`CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU` was deployed at
ledger **3899359**. At the time of writing that genesis is ~4.4 days old — it
falls out of the RPC's reach in roughly **2.6 days**, during this hackathon's
judging weekend. After that, no wallet can be built from scratch against this
pool without an index that captured the history first.

### 2. The compliance record is only as durable as a pairing

ASP roots change. A regulator asking, in 2035, *"who was in the approved set on
this date, and was that root honestly built?"* needs to verify a 2026 proof.

Today those proofs are Groth16 over BN254: they need a trusted setup — a
ceremony in which someone promises to have destroyed a number — and they are
retroactively forgeable by an adversary with a quantum computer. A privacy pool
writes to a permanent ledger; the compliance layer is exactly the part expected
to still mean something a decade later.

---

## What this is

Two pieces of infrastructure, each useful alone, and complementary.

**A durable ASP and pool index.** Every `NewCommitmentEvent`,
`NewNullifierEvent` and ASP root change, captured from the pool's genesis
ledger and kept past the RPC's window, with an explicit account of what has and
has not been observed. A wallet points at it and scans.

**Post-quantum attestation of ASP root history.** A hash-based Circle-STARK
proof, verified by a Soroban contract, that a published ASP root was built from
exactly the leaves claimed — no elliptic curve, no trusted setup, nothing for
Shor's algorithm to undo on a permanent ledger.

## What this is not

Stated first, because a compliance tool that overstates itself is worse than
none.

- **It does not replace the Groth16 circuit.** The pool's membership proof
  lives inside the circuit; swapping the proof system means rewriting the
  circuit, which is not two days of work and is not attempted here. What is
  offered is a parallel, durable attestation of the root's *construction*, at
  the seam the pool already exposes.
- **It is not audited**, and neither is what it builds on. Stellar Private
  Payments describes itself as a work-in-progress reference implementation, and
  so does this.
- **The post-quantum verifier's own limits are published**, not implied: 92
  bits of classical soundness and 46 against a quantum adversary, a compression
  function that is known not to be collision resistant, and a zero-knowledge
  argument two of whose components are proved and the rest inherited. Full
  accounting in the linked repository rather than a footnote here.

---

## Measured, not asserted

Every number in this README came out of a command that anyone can re-run;
`docs/EVIDENCE.md` records how. Where something has not been measured, it says
so instead of rounding up.

## License

MIT.

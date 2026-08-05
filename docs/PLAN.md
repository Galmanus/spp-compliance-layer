# What this submission actually is

Three layers of infrastructure that privacy wallets need and nobody is
building, each drawing on a distinct body of prior work, unified by one
uncomfortable fact: **the primitives this whole lane is built on describe
themselves as unaudited works in progress.** Twenty teams will build wallets on
top of contracts nobody has verified. This is the layer that makes those
wallets trustworthy.

## Layer 1 — adversarial audit of the primitives (sorohunter)

The lane's own primitives — Nethermind's Stellar Private Payments pool and
OpenZeppelin's Confidential Token — screened by sorohunter, a fork-validated
Soroban attack engine whose one invariant is that a finding is an executed
invocation sequence against the real WASM in a local soroban-sdk fork, never an
inference. It never touches the live network. This is what the judges do for a
living, turned on the contracts they wrote, reproducible by execution.

## Layer 2 — the durable index (running)

The RPC keeps 7.02 days of events (measured: 120,959 ledgers). A wallet finds
its own notes by trial-decrypting every commitment ever emitted; miss the
history and the notes are unspendable. This index captures from genesis and
proves completeness rather than asserting it. The pool's genesis leaves the
RPC's reach in ~3 days, during judging weekend. The clock is in the tool.

## Layer 3 — post-quantum attestation of ASP roots (riverrun)

ASP roots are attested by Groth16 over BN254: a trusted setup to rely on, a
quantum adversary to outlive, on a permanent ledger. A hash-based Circle-STARK
attestation removes both at the seam the pool already exposes (get_root). Its
limits are published, not implied: at the shipped 128 queries, 124 bits
classical, 62 quantum (the QM31 field ceiling), a compression function not
assumed collision resistant.

## The spine (metacognitive security paper)

Why all three are necessary: correctness arguments that live at the generative
layer are provably incomplete. You do not trust a construction's promise about
itself; you measure it from outside. Audit by execution, completeness by
coverage accounting, durability by a proof that outlives its own assumptions.

## Honesty, which is the whole brand

Every claim traces to a command anyone re-runs. The primitives are unaudited;
so is this. The reason to trust it is not that it claims to be secure — it is
that it turns its instrument on itself and reports what it finds.

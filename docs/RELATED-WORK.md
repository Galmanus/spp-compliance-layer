# Related work, and a precise novelty claim

On-chain zero-knowledge verification is not new on Stellar. Being honest about
exactly what exists is what makes this project's claim defensible rather than
loose. This note states the prior and concurrent work, then the narrow claim that
survives it, then the scaling path.

## What already exists on Stellar

Protocol 25's X-Ray upgrade made on-chain proof verification practical, and a
healthy set of projects use it. Every one of them verifies **pairing-based**
proofs over BN254, which a quantum computer breaks:

- **Groth16 / Circom** verifiers on Soroban (`stellar/soroban-examples`,
  `salazarsebas/stellar-zk`) — BN254 pairing check, ~12M instructions.
- **UltraHonk / Noir** verifiers (`NethermindEth/rs-soroban-ultrahonk`,
  `Errorist79/zkPoR`, StellarVeil) — KZG/BN254 pairing.
- **RISC Zero** on Stellar produces a STARK, but **wraps it into a ~260-byte
  Groth16 seal over BN254** for on-chain verification. The on-chain step is a
  pairing check, not a hash-based one — so it is *not* post-quantum on-chain.

Post-quantum work on Stellar so far targets **signatures and account
abstraction**, not proof systems for application logic:

- Stellar's own Quantum Preparedness Plan (June 2026) adds ML-DSA / Falcon as
  Soroban host functions for signers, and states plainly that *"there is no
  drop-in post-quantum replacement for pairing-based SNARKs"* — the ZK layer is
  named as an open research problem.
- **SoundnessLabs/stellar-pq** ships a Falcon-512 signature verifier as a Soroban
  contract and a smart account, and is prototyping a WHIR-based (post-quantum)
  proof-of-seed verifier (benchmarks in progress, not yet deployed).

## The claim that survives

Given the above, the precise, checkable claim is:

> To our knowledge, this is the first **transparent, hash-based STARK** (Circle-
> STARK over Mersenne-31, FRI with a keccak Merkle commitment) verified
> **natively** on-chain on Stellar --- not wrapped in a BN254 seal, not a
> signature scheme --- and the first applied to privacy-pool compliance and made
> load-bearing (a root is admitted, and a pool spends, only if the proof holds).

It builds on our own earlier `riverrun-soroban`, which established that an M31
Circle-STARK verifier compiles and runs on Soroban; the new contribution here is
the append-only-history compliance AIR, its on-chain gate, and the consuming
pool. We do not claim to be first at on-chain ZK on Stellar (we are not), nor
first at post-quantum on Stellar (SoundnessLabs' signature work predates this),
only at native transparent-STARK verification wired into a compliance flow. If a
prior native FRI-based verifier on Soroban surfaces, this claim narrows to the
compliance application; the receipts and the code stand regardless.

## The honest ceiling, and the scaling path

On-chain, a single transaction's 400M-instruction cap bounds the FRI query count,
so the shipped on-chain security is 48 classical / 24 quantum bits at 40 queries
--- below the 62 quantum bits the same construction reaches off-chain, and well
below a 128-bit target. More queries do not fit in one transaction.

The field's answer is **recursion / proof aggregation**, and notably it is the
sponsor's own research:

- **STARKPack** (Nethermind) packs many FRI-based STARK instances so the verifier
  runs *one* low-degree test across all of them --- ~2x faster verification, ~3x
  smaller proofs.
- **stwo-cairo** (StarkWare) implements a Circle-STARK verifier *inside* Cairo, so
  a proof can verify a proof; a high-security inner proof is checked off-chain,
  and only a succinct recursive proof is verified on-chain at bounded cost.
- **`Errorist79/zkPoR`** already folds batch proofs into one terminal proof
  verified on Stellar testnet at Protocol 27, showing recursion is live on
  Soroban today (for UltraHonk).

The scaling path for this project is therefore stated, not hand-waved: the
on-chain verifier here is the *base case*. A recursive layer --- proving the
high-query (62-quantum-bit) verification inside a STARK and verifying that
succinct proof on-chain --- lifts the on-chain security to the off-chain level at
bounded transaction cost. That is engineering on top of an established technique
(Nethermind's own), not new cryptography, and it is scoped as future work rather
than claimed as done.

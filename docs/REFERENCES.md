# References and cryptographic grounding

This project is built on published primitives, and its security rests on stated
assumptions from the literature. This note grounds each claim in a primary
source, and is honest about which assumptions are proven and which are
conjectured — including a development from late 2025 that a careful reviewer will
know.

## The compliance mechanism: Privacy Pools

Our premise — an Association Set Provider (ASP) publishes a Merkle root over an
approved set, and a wallet proves membership against it — is exactly the
mechanism of **Privacy Pools**:

> Buterin, Illum, Nadler, Schär, Soleimani. *Blockchain Privacy and Regulatory
> Compliance: Towards a Practical Equilibrium.* 2023.
> <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4563364>

The paper defines the association-set root as a public input a user proves
membership into, creating a separating equilibrium between compliant and
non-compliant withdrawals. Nethermind's SPP is an implementation of this idea on
Stellar.

Crucially, the canonical "Proof of Innocence" pattern that formalizes this names
the exact risk this project addresses:

> "**Set-provider integrity.** A malicious or compromised provider can include or
> exclude specific deposits, effectively censoring users or diluting the
> compliance signal." — Ethereum IPTF, *Proof of Innocence (Association Set
> Proofs)*.

Our durable index proves the ASP root history is **complete** (no omitted leaf
goes unreported — the coverage proof that mitigates the set-provider-integrity
risk), and our post-quantum attestation adds a proof of its **append-only index
structure** (gap-free indices, endpoints pinned; the roots are witnessed — see
[`LAYER3-DESIGN.md`](LAYER3-DESIGN.md), stated precisely). Together they move the
guarantee from "trust the provider / cross-check several" to "check the coverage
proof, and check one post-quantum proof of the structure".

## The proof system: Circle STARKs over Mersenne-31

The Layer-3 attestation uses a Circle-STARK, the construction of:

> Haböck, Levit, Papini. *Circle STARKs.* IACR ePrint 2024/278.
> <https://eprint.iacr.org/2024/278>

operating over the Mersenne-31 field (`p = 2^31 − 1`) with the QM31 degree-4
challenge extension, via the `riverrun-m31` crate (itself built on Plonky3's
`p3-circle` / `p3-uni-stark`). It is transparent (no trusted setup) and
hash-based, which is what makes it a post-quantum candidate: security reduces to
collision-resistance of the hash and FRI soundness, both of which a quantum
adversary only speeds up quadratically (Grover), not breaks (Shor).

## The soundness basis, stated honestly

FRI soundness for these parameters rests on **Reed–Solomon proximity-gap**
assumptions:

> Ben-Sasson, Carmon, Ishai, Kopparty, Saraf. *Proximity Gaps for Reed-Solomon
> Codes.* FOCS 2020, IACR ePrint 2020/654. <https://eprint.iacr.org/2020/654>

Two regimes matter, and we do not blur them:

- **Proven (up to the Johnson bound).** Soundness is unconditional but more
  conservative — fewer bits per query.
- **Conjectured (up to list-decoding capacity).** More bits per query, but it is
  an assumption, and in **late 2025 the strongest form was disproven**:

  > Crites, Stewart. *On Reed–Solomon Proximity Gaps Conjectures.* IACR ePrint
  > 2025/2046 (Nov 2025). <https://eprint.iacr.org/2025/2046> — disproves the
  > correlated-agreement and DEEP-FRI list-decodability up-to-capacity
  > conjectures.
  >
  > Ben-Sasson, Carmon, Haböck, Kopparty, Saraf. *On Proximity Gaps for
  > Reed–Solomon Codes.* IACR ePrint 2025/2055 (Nov 2025).
  > <https://eprint.iacr.org/2025/2055> — improved proven bounds; beyond-Johnson
  > needs new list-decoding results. Subsequent work (ePrint 2026/858, 2026/861)
  > proves above-Johnson soundness at a ~2x query cost.

**What this means for our numbers.** The 124 classical / 62 quantum figure at 128
queries follows `riverrun-m31`'s round-by-round accounting. It is a
proximity-gap-assumption figure, not an unconditional Johnson-bound one; under
the conservative proven regime the bit count is lower (and the honest response is
simply more queries, which is why the parameter is exposed and centralized in
`attestation/src/lib.rs`). Production-deployed STARK systems (Starknet's Cairo,
Plonky3 rollups) make the same class of assumption today; we state ours rather
than leave it implicit, and we note the 2025 developments a reviewer will know.
The on-chain figure (24 quantum bits at 40 queries) is a demonstration level, not
a production one, as stated throughout.

## The scaling path: recursion and faster proximity testing

Lifting the on-chain security to the off-chain level at bounded transaction cost
is a known technique, not new cryptography:

> Nethermind. *STARKPack: Aggregating STARKs for shorter proofs and faster
> verification.* 2024. — packs many FRI instances into one low-degree test.
>
> Arnon, Chiesa, Fenzi, Yogev. *WHIR: Reed–Solomon Proximity Testing with
> Super-Fast Verification.* IACR ePrint 2024/1586, EUROCRYPT 2025.
> <https://eprint.iacr.org/2024/1586> — the post-quantum proximity test
> SoundnessLabs is prototyping on Soroban; a sub-millisecond verifier that is a
> drop-in for FRI.

These are the base of the roadmap in [`RELATED-WORK.md`](RELATED-WORK.md): the
on-chain verifier here is a base case a recursive layer would sit on.

## Hashing

The STARK's Merkle commitment and Fiat-Shamir channel use keccak256 (via
Soroban's native host function on-chain). The ASP tree itself hashes with
Poseidon2 over BN254 (CAP-0075), which the attestation treats as a witnessed
label rather than reproving — see [`LAYER3-DESIGN.md`](LAYER3-DESIGN.md).

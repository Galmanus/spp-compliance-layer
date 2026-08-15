# Threat model

Privacy Pools and its "Proof of Innocence" pattern enumerate the risks of an
association-set compliance system. We map each to what this layer covers, what it
does not, and where the boundary is. Honesty about the boundary is the point:
every "out of scope" row is a claim we are *not* making.

| Risk (from the Privacy Pools / IPTF literature) | This layer | How |
|:--|:--|:--|
| **Set-provider integrity** — a provider serves a forged history, or censors / injects deposits | **Mitigated by Layer 2; Layer 3 adds a PQ shape proof** | The **Layer-2 coverage proof from genesis** is what catches omission/censorship: an omitted event is a reported gap, never hidden. The Layer-3 STARK adds a post-quantum proof of the append-only *index structure* (gap-free indices, endpoints pinned) — but it witnesses the roots, so its guarantee holds only for a verifier who independently knows the true endpoints (readable on-chain). We do not claim the attestation alone makes a forged history unprovable; see [`LAYER3-DESIGN.md`](LAYER3-DESIGN.md). |
| **Handoff integrity** — a bootnode returns a misleading `fromLedger`, skipping a range | **Mitigated** | The handoff point is bounded by proven-contiguous coverage from genesis (`getCoverage`); a wallet verifies the archive held everything below it before trusting it. |
| **Stale sets** — a newly-flagged deposit still proves clean until the set updates | **Partial** | The attestation and gate carry each root's index; the gate records the admitted index, so a consumer can require freshness (spend only against the latest admitted root). Enforcing a freshness window is the consuming pool's policy, not this layer's to mandate. |
| **Proof-system soundness / trusted setup** of the membership proof | **Out of scope (theirs)** | The SPP membership proof is Groth16 over BN254 with its own setup; we attest the root *history*, not re-prove the membership circuit. |
| **Quantum retrospective de-anonymization** of the privacy itself | **Out of scope (open problem)** | SPP/OZ privacy is BN254, quantum-vulnerable; the SDF states no drop-in PQ replacement exists. Our attestation makes the *compliance record* post-quantum, not the privacy. Stated, not implied. |
| **Small anonymity set** — a valid proof conveys little privacy in a tiny set | **Out of scope** | Orthogonal: a function of the pool's set size, not of the history's integrity. |
| **Metadata** — relayer IP, timing, gas payer | **Out of scope** | Network-layer, outside any on-chain artifact. |
| **The captured history is not the real history** | **Mitigated by construction** | The attestation proves the history it is *given* is honest; that the given history matches the chain is the index's completeness accounting (coverage intervals from genesis), a gap in which is reported, never hidden. |

## Inclusion and exclusion — the full Privacy Pools model

Privacy Pools is two-sided: a user proves membership in a *good* set (inclusion)
or non-membership in a *bad* set (exclusion / "proof of innocence"). Nethermind's
SPP ships both an ASP-membership and an ASP-non-membership contract, each
publishing a root history via `LeafAdded` events.

The append-only-history AIR is **agnostic to which side it attests**: it proves a
sequence of `(index, root)` steps is a gap-free, append-only index structure
over witnessed roots (endpoints pinned; roots not re-derived),
whichever set the roots summarise. So the same Layer-3 attestation, gate, and
completeness accounting cover both the inclusion and the exclusion root histories
with no change — the whole compliance model, not half of it. The on-chain
demonstration uses the membership (inclusion) contract; pointing the same
pipeline at the non-membership contract attests the exclusion side identically.

## The production membership check

The reference `guarded-pool` demonstrates the gating *pattern*: a spend is
admitted only if the root it references is post-quantum-attested by the gate. A
production pool adds the second half — a Merkle **membership proof** that the
user's note is a leaf under that attested root — verified on-chain against the
ASP's real tree. Stellar exposes exactly the primitive for this: the CAP-0075
`poseidon2_permutation` host function (the same Poseidon2-over-BN254 the ASP tree
uses), available in `soroban-sdk` under the `hazmat-crypto` feature. Wiring the
membership check to the ASP's specific tree parameters is the integration step;
the gating pattern it hangs on is what this project demonstrates end to end.

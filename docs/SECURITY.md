# Security model

What the attestation proves, what it assumes, and what it explicitly does not
claim — stated precisely, because a compliance tool that is vague about its own
guarantees is worse than none.

## The statement being proven

Given a sequence of ASP `LeafAdded(leaf, index, root)` events, the Layer-3
Circle-STARK proves the predicate:

> the events form a **gap-free append-only index structure over witnessed
> roots**: the indices are `s, s+1, s+2, …` with no gap; padding rows repeat
> the last root; and the first and last roots equal the public values the
> verifier checks against. (The roots are witnessed inputs, not re-derived or
> cryptographically chained — see "What is assumed, not proven" below.)

Formally, for committed rows `(idxᵢ, rootᵢ)` with a real/padding selector `pᵢ`:

```
p₀ = 1
∀i:  pᵢ ∈ {0,1}                              (boolean selector)
∀i:  pᵢ₊₁ · (idxᵢ₊₁ − idxᵢ − 1) = 0          (real rows advance the index by one)
∀i:  (1 − pᵢ₊₁) · (rootᵢ₊₁ − rootᵢ) = 0      (padding repeats the last root)
idx₀ = start_index,  root₀ = first_root       (first-row pin)
root_last = last_root                         (last-row pin)
```

A prover who submits a **reordered or gap-having** history cannot satisfy the
index constraint, so no verifying proof exists for such a history. (In a debug
build the prover's constraint check fails closed at proving time; in release it
emits a proof that then fails verification.) This does **not** extend to a
fabricated history with chosen endpoints: because the roots are witnessed inputs
(not re-derived), a made-up sequence with self-consistent indices and chosen
first/last roots *does* verify — the passing test
`witnessed_roots_a_fabricated_sequence_also_verifies` in
`attestation/tests/roundtrip.rs` pins exactly this. The attestation is therefore
meaningful only to a verifier who **independently knows the true endpoints** —
see "What is assumed, not proven" below.

## What a quantum adversary cannot do

The security rests on the collision resistance of the hash inside the STARK and
on FRI soundness — both hash-based, so a quantum adversary gains only a Grover
square-root speedup, not a Shor break. The figures are computed for THIS
attestation's actual config (`attestation/src/lib.rs`: `log_blowup = 1`, QM31
degree-4 challenge field, 8 PoW bits), using riverrun-m31's own round-by-round
formula (`examples/qm31_ceiling.rs`):

- at the shipped **128 queries**: **124 bits classical, 62 bits against a quantum
  adversary** (Grover halves it);
- 62 quantum bits is the QM31 field ceiling — additional queries do not exceed
  it, and a larger extension field would be new cryptography;
- the earlier 20-query setting was **28 / 14 bits**, not the 92 / 46 an earlier
  draft cited (that figure was riverrun's binding proof at a different config,
  and did not describe this attestation).

These are the honest figures. 62 quantum bits is below a 128-bit production
target: the attestation is post-quantum in construction (hash-based, no trusted
setup) but this parameterisation is a demonstration at the field ceiling, not a
system to place real value behind — stated here rather than left implied.

## The soundness regime, and a late-2025 development

The figures above are **proximity-gap-assumption** figures, in the sense every
FRI-based STARK reports. FRI soundness reduces to Reed–Solomon proximity gaps
(Ben-Sasson–Carmon–Ishai–Kopparty–Saraf, *Proximity Gaps for Reed-Solomon
Codes*, ePrint [2020/654](https://eprint.iacr.org/2020/654)). There are two
regimes and we do not blur them:

- **proven, up to the Johnson bound** — unconditional, more conservative (fewer
  bits per query);
- **conjectured, up to list-decoding capacity** — more bits per query, but an
  assumption, and in **November 2025 its strongest form was disproven**
  (Crites–Stewart, ePrint [2025/2046](https://eprint.iacr.org/2025/2046);
  improved proven bounds and a ~2x-query above-Johnson result followed in
  [2025/2055](https://eprint.iacr.org/2025/2055) and 2026/858).

Under the conservative proven regime the bit count is lower, and the honest
remedy is simply more queries — which is why the query count is a single exposed
parameter (`attestation/src/lib.rs`). Production STARK systems (Starknet's Cairo,
Plonky3 rollups) make the same class of assumption today; we state ours and note
the 2025 developments a reviewer will know. Full grounding in
[`REFERENCES.md`](REFERENCES.md).

## What is assumed, not proven

1. **The roots are witnessed labels, and are not chained or anchored.** The AIR
   does no arithmetic on the roots — it does not derive `root_{n+1}` from
   `root_n` (the Poseidon2-BN254 compression is a different-field oracle, out of
   scope), and `first_root`/`last_root` are public *inputs* a prover chooses.
   Consequently the attestation proves the append-only *index structure*
   (gap-free consecutive indices, pinned endpoints, padding) — **not** that the
   roots are the real ASP roots. A fully fabricated sequence verifies: attesting
   `[{index:0,root:1},{1,999999},{2,7}]` yields a VALID proof. The guarantee is
   meaningful only to a verifier who **independently knows the true endpoints**
   (the ASP's genesis and current roots, readable on-chain); for such a verifier
   it proves the sequence between them is gap-free and correctly counted. See
   [`LAYER3-DESIGN.md`](LAYER3-DESIGN.md).

2. **The anti-omission / completeness guarantee is Layer 2's, not Layer 3's.**
   That the captured history matches what the chain actually emitted is the
   *index's* job, backed by the coverage-interval accounting from genesis (gaps
   reported, never hidden). The attestation proves the *shape* of whatever
   history it is given; the coverage proof is what binds that history to the
   chain. Neither alone is the whole claim — together, against trusted endpoints,
   they are.

3. **A Poseidon2 collision** could substitute one leaf for another of equal hash;
   that is the SPP's assumption to make, and this layer does not solve it.

4. **The root tag encoding is injective.** BN254 roots (~254 bits) are carried
   as nine 31-bit Mersenne limbs (279 bits of tag space), which is injective on
   distinct roots; `root_to_limbs` is tested for this in
   `mirror-pool`'s `asp_history` tests.

## What is out of scope

- **This does not replace the Groth16 membership circuit.** The pool's
  deposit/withdraw proofs are unchanged; this is a *parallel* attestation of the
  root's construction at the seam the pool already exposes (`get_root`).
- **The pool does not consume this attestation today.** Wiring the pool to
  require it is a contract change, not claimed here.
- **The index and the demo run on testnet.** No mainnet deployment, no real
  value.

## Reproducing the security claims

```bash
# the append-only-chain constraints, and that a forged history never verifies:
cd attestation && cargo test --release

# the soundness accounting for this config (124/62 bits at 128 queries), with the
# round-by-round model and every error term, in the mirror-pool repo:
cargo run --release --example qm31_ceiling
```

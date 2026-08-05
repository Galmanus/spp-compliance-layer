# Security model

What the attestation proves, what it assumes, and what it explicitly does not
claim — stated precisely, because a compliance tool that is vague about its own
guarantees is worse than none.

## The statement being proven

Given a sequence of ASP `LeafAdded(leaf, index, root)` events, the Layer-3
Circle-STARK proves the predicate:

> the events form a **consistent append-only chain**: the indices are
> `s, s+1, s+2, …` with no gap; each row's root is carried unchanged into the
> next as the tree's own update algorithm chains them; and the first and last
> roots equal the public values the verifier checks against.

Formally, for committed rows `(idxᵢ, rootᵢ)` with a real/padding selector `pᵢ`:

```
p₀ = 1
∀i:  pᵢ ∈ {0,1}                              (boolean selector)
∀i:  pᵢ₊₁ · (idxᵢ₊₁ − idxᵢ − 1) = 0          (real rows advance the index by one)
∀i:  (1 − pᵢ₊₁) · (rootᵢ₊₁ − rootᵢ) = 0      (padding repeats the last root)
idx₀ = start_index,  root₀ = first_root       (first-row pin)
root_last = last_root                         (last-row pin)
```

A prover who submits a reordered, gap-having, or leaf-injected history cannot
satisfy the index constraint, so **no proof that verifies exists** for such a
history. (In a debug build the prover's constraint check fails closed at proving
time; in release it emits a proof that then fails verification. Both preclude a
verifying proof of a forged history — see `attestation/tests/roundtrip.rs`.)

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

## What is assumed, not proven

1. **The root is a witnessed label, not a reproven hash.** The ASP hashes with
   Poseidon2 over BN254; this STARK is over Mersenne-31. The AIR does no
   arithmetic on the root — it proves the *shape* of the history around
   witnessed root values. A collision in the ASP's Poseidon2 could substitute
   one leaf for another of equal hash; that is the SPP's assumption to make, and
   this layer does not solve it.

2. **The captured history is the real history.** The attestation proves the
   history it is given is an honest chain. That the given history matches what
   the chain actually emitted is the *index's* job, and the index's completeness
   accounting (coverage intervals, gap reporting) is what backs it — a gap in
   coverage is a gap in the guarantee, and is reported, never hidden.

3. **The root tag encoding is injective.** BN254 roots (~254 bits) are carried
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

# the soundness accounting (92/46 bits), with the model and every error term:
#   in the mirror-pool repo:
cargo run --release --example soundness_budget
```

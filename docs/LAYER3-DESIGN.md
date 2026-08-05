# Layer 3 — post-quantum attestation of ASP root history

## The obstacle, stated so nobody repeats the naive version

The ASP tree hashes with **Poseidon2 over BN254** (`p ≈ 2^254`, the pairing
field): `contracts/soroban-utils/src/poseidon2.rs:25`, permutation width 2,
compression `perm(l,r)[0] + l`. riverrun's STARK proves **Poseidon2 over
Mersenne-31** (`p = 2^31 - 1`). Different permutation, different field,
different round constants.

So the riverrun binding verifier **cannot** be pointed at an ASP root as-is: it
would prove the wrong hash, and an attestation of the wrong computation attests
nothing. Reimplementing BN254-Poseidon2 inside an M31 AIR is weeks of work and
out of scope. That path is closed, and closing it explicitly is the point —
a hash-based attestation is only meaningful if it proves the *actual* hash or
does not claim to.

## What Layer 3 proves: the append-only INDEX STRUCTURE over witnessed roots

Groth16 attests a single root at a single moment. A regulator in 2035 asking
"was this approval set built honestly?" needs a statement about the *sequence*,
not a snapshot. Layer 3 makes a precise, and deliberately narrow, one.

Read the AIR (`asp_history.rs`, `eval`). Its columns are `[index, root_limbs(9),
is_real_selector]`; its public values are `[start_index, first_root, last_root]`.
It enforces exactly:

- `is_real` is boolean;
- **first row:** `index == start_index` and `root == first_root` (the low
  endpoint is pinned to a public value);
- **last row:** `root == last_root` (the high endpoint is pinned);
- **real→real transition:** `index_{n+1} == index_n + 1` — gap-free, monotone,
  no reordering *within the trace*;
- **real→padding transition:** padding repeats the last root, so the tail pin is
  meaningful however much padding follows.

That is the whole constraint system. Two things it importantly does **not** do,
and we state them plainly rather than let the word "chain" imply them:

1. **It does not cryptographically chain the roots.** There is no constraint that
   `root_{n+1}` is derived from `root_n` and a leaf — the Poseidon2-BN254
   compression is a witnessed oracle in a different field (M31), out of scope, as
   the honest-scope section below and `SECURITY.md` state. The intermediate roots
   are free field elements.
2. **It does not anchor the endpoints to reality.** `first_root` and `last_root`
   are public *inputs*; a prover chooses them. Consequently a prover can attest a
   *fabricated* sequence: any consecutively-indexed rows with any endpoints
   verify. We verified this by executing it — attesting `[{0,1},{1,999},{2,7}]`
   yields a VALID proof (see `attestation/tests` and `SECURITY.md`).

So the honest statement of the guarantee: **for a verifier who independently
knows the true endpoints** (the ASP's genesis root and its current root, both
readable on-chain from the ASP contract), the attestation proves the index
sequence between them is gap-free, correctly counted, and monotone — an ordering
and no-gap proof, post-quantum and verifiable on-chain in 2035. The *anti-omission
completeness* guarantee — that the captured history matches what the chain
actually emitted — is provided by **Layer 2's coverage-interval proof from
genesis**, not by this attestation. Layer 3 proves the shape; Layer 2 proves the
capture is complete; together, against trusted endpoints, they are the compliance
statement a snapshot proof cannot make.

## Honest scope

- This attests root-history STRUCTURE, not hash preimage security. A forged
  Poseidon2 collision could substitute one leaf for another of equal hash; that
  is the SPP's assumption to make, not this layer's to solve.
- It is a parallel attestation the pool does not consume today. The pool exposes
  `get_root`; wiring the pool to REQUIRE this attestation is a contract change
  and is not claimed as done.
- Numbers for the STARK itself, computed from riverrun-m31's own round-by-round
  accounting for THIS attestation's config (`log_blowup = 1`, QM31 degree-4
  field, 8 PoW bits): at the shipped 128 queries, **124 bits classical, 62
  quantum**. 62 is the QM31 field ceiling — more queries do not exceed it, and a
  larger extension field (new crypto) is needed to go higher. The earlier docs
  cited 92/46; that was riverrun's binding-proof figure at a different config,
  and did not describe this attestation, whose earlier 20-query setting was in
  fact 28/14. Corrected here and set to the ceiling. The compression function is
  not assumed collision resistant (see the STRUCTURE caveat above).

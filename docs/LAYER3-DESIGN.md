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

## What Layer 3 proves instead: the history, not the instant

Groth16 attests a single root at a single moment. A regulator in 2035 asking
"was this approval set built honestly?" needs more than that a root exists —
they need that the sequence of published roots is an **append-only chain**: each
`LeafAddedEvent(leaf, index, root)` advanced the index by exactly one, and each
root follows from inserting exactly that leaf at that position over the previous
root, with no removal and no reordering.

That is a statement about the *transition* between roots, and it is exactly the
compliance property that matters and that a snapshot proof cannot make. The
history it is a statement about is precisely what Layer 2's index captures — and
what the RPC deletes after seven days, which is why a durable attestation of it
has standalone value.

## The AIR, and why the expensive hash is not reproven

The Poseidon2-BN254 compression is a witnessed oracle, not a reproven circuit.
The AIR constrains the STRUCTURE of the update:

- `index_{n+1} = index_n + 1` — monotone, gap-free, matching the event stream;
- the path recomputation touches exactly the siblings the tree's own algorithm
  touches (`asp-membership/lib.rs:214-234`), witnessed;
- `root_n` feeds `root_{n+1}` as the algorithm chains them.

The hash outputs along the path are witnessed field elements; the AIR proves the
tree was UPDATED correctly given them, not that Poseidon2 is collision
resistant — which the SPP itself does not claim, and which its own
`docs/COMPRESSION-NOTE.md` counterpart in riverrun shows is false for the M31
combiner too. What a post-quantum adversary cannot forge here is the *shape* of
the history: a reordered or leaf-injected chain fails the index and continuity
constraints regardless of hash strength.

## Honest scope

- This attests root-history STRUCTURE, not hash preimage security. A forged
  Poseidon2 collision could substitute one leaf for another of equal hash; that
  is the SPP's assumption to make, not this layer's to solve.
- It is a parallel attestation the pool does not consume today. The pool exposes
  `get_root`; wiring the pool to REQUIRE this attestation is a contract change
  and is not claimed as done.
- Numbers for the STARK itself (92 bits classical, 46 quantum, the compression
  caveat) carry over from riverrun unchanged and are published there.

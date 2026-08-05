# On-chain post-quantum verification

The Layer-3 attestation is not only checkable off-chain by a regulator. It is
verified **on-chain**, inside a Soroban contract, in a single Stellar
transaction. To our knowledge this is the first time a transparent
(trusted-setup-free) post-quantum proof has been verified on-chain on Stellar as
part of a privacy-pool compliance flow. We state that as a checkable claim, not a
superlative: the Stellar Development Foundation itself writes that there is ``no
drop-in post-quantum replacement for pairing-based SNARKs'', and Stellar's privacy
primitives (SPP Groth16, OpenZeppelin UltraHonk) are entirely BN254.

## The receipts (Stellar testnet)

- **Contract:** `CCWNNU4K3LWEPFRI7HLXV2WA2CV7C4Z7MFMWP7I7JZWESLTLPNHPCWRG`
- **Honest proof verifies (returns `true`):**
  tx `96110dc19ea1ea63b888bbcd02fbb7c2c76a5d91ff03aa2ce14797e7f83e6718`
- **Tampered public root is rejected (returns `false`):**
  tx `ee36ca3dacb7e7b0c9dfa83afbcb07a5f5b775a27d9674678fa005e07eadea5f`
- Fee for the honest verification: **385,485 stroops (~0.0385 XLM)**.

Both transactions verify the attestation of the **real** 15-leaf history captured
from the deployed `asp-membership` contract — not a synthetic fixture.

## The attestation is load-bearing, not parallel: the compliance gate

Verifying a proof is one thing; making on-chain state *depend* on it is what
turns the attestation from a parallel artifact into a working mechanism. The
contract's `admit_root` verifies the post-quantum attestation and **only on a
valid proof** records the endpoint root as compliance-admitted and emits an
`admitted` event. Without a valid proof, the transaction is rejected and no root
is admitted. A pool or wallet checks `is_attested(root)` before honouring a
membership proof against that root.

Receipts (Stellar testnet), gated contract
`CBY2N5KH26SS6O23FNZ3XICWIKAAQO7LVEDAOZ6HZ5GD6U52UDMV5WXW`:

- **Valid proof admits the real root** →
  tx `fa5865c3b740fc895957a1cf129ea9cf0763e7a706ed294546501ef1aff5c7ed`,
  returns index `14`, emits
  `admitted(root=42ee8f6f…) = 14`;
- `is_attested(42ee8f6f…)` → **`true`** (the admitted root);
- `is_attested(0000…)` → **`false`** (a root never admitted);
- **Tampered proof is rejected on-chain** → the `admit_root` transaction traps
  (`post-quantum attestation did not verify: root not admitted`), changing no
  state.
- **A proof below the security floor is rejected** → `admit_root` enforces a
  minimum of 40 FRI queries (`MIN_QUERIES`). A self-audit found that, without
  this floor, an attacker could grind a cheap low-query proof (e.g. 1 query ~9
  bits) of a *forged* history and have it admitted. With the floor, an
  `admit_root` at 8 queries traps on-chain
  (`num_queries below the on-chain security floor`), even though that proof would
  "verify" at its own weak query count. The floor is enforced *before*
  verification, so a weak proof cannot admit a root regardless. (`verify` is the
  raw primitive and is intentionally unfloored, to measure any query count; the
  gate is what enforces the floor.)

`admit_root` (verify + storage write + event) costs 260,595,609 instructions at
40 queries --- 65.1% of one transaction's budget, essentially the verification
cost, since the storage write is negligible beside the STARK.

This is the closed loop: a root is compliance-admitted on Stellar **only** if a
hash-based post-quantum proof of the honest append-only history verifies in the
same transaction.

## The full loop: a pool consumes the gate

The gate admits roots; a pool must actually *use* that verdict for the loop to
close. `guarded-pool/` is a minimal pool that, before honouring a spend, asks the
gate --- cross-contract --- whether the root is attested. If not, the spend is
refused by the chain.

```
post-quantum attestation  ->  admit_root (gate verifies the STARK on-chain,
   (STARK, off-chain proof)     admits the root)  ->  is_attested = true
                                                          |
                                                          v
   guarded pool: spend(root, note)  --calls is_attested on the gate-->  allowed
   spend against an un-admitted root  --------------------------------> refused
```

Receipts (testnet), pool `CBO4RLRKYJ5442P6P4ZFUZSENBCFOGBSJW2Y34YQQRMUASVFVG7R6WYF`
wired to gate `CBY2N5KH…`:

- **Spend against the attested root succeeds** →
  tx `6005bd172de821b01db73f97ca2375b6d2804355ef91895efeb04b16cd844b92`,
  emits `spent(root=42ee8f6f…)`, and `is_spent(note)` then reads `true`;
- **Spend against a root the gate never admitted is refused** on-chain
  (`root is not compliance-attested by the gate; spend refused`);
- **Replaying a spent note is refused** (`note already spent`).

So a real state-changing action on Stellar now depends, transitively, on a
hash-based post-quantum proof: no attestation, no admitted root; no admitted
root, no spend. That is the loop closed on both sides.

## What was verified

The contract (`onchain-verifier/`) takes the postcard-encoded append-only-history
Circle-STARK proof and its public values (`start_index`, `first_root`,
`last_root`, as little-endian u64 limbs) and returns whether it verifies. It uses
the same `riverrun-m31` revision as the off-chain attestation, routed to
Soroban's native `keccak256` host function, so the same proof our
`attest-asp-history` binary produces is what the chain checks.

## Feasibility, measured on the metered host

Instruction counts below are from the real optimized wasm called through the
Soroban test host (not a native approximation), across FRI query counts, for the
15-leaf history:

| queries | on-chain result | CPU instructions | % of 400M tx cap | proof size |
|:--|:--:|--:|--:|--:|
| 8  | accept | 57,559,420  | 14.4% | 9,160 B |
| 16 | accept | 108,309,938 | 27.1% | 17,488 B |
| 20 | accept | 133,656,962 | 33.4% | 21,648 B |
| 27 | accept | 178,069,987 | 44.5% | 28,916 B |
| **40** | **accept** | **260,420,737** | **65.1%** | **42,469 B** |

The shipped on-chain configuration is **40 queries**: it verifies in one
transaction with ~35% CPU headroom. The wasm is 112 KB, under Soroban's 128 KB
code limit.

## The honest security trade-off

On-chain, the CPU cap bounds the query count, so the security is lower than the
off-chain attestation:

- **off-chain** (128 queries): 124 classical / **62 quantum** bits — the QM31
  field ceiling;
- **on-chain** (40 queries, one transaction): 48 classical / **24 quantum** bits.

So the strong version runs off-chain for a regulator, and the on-chain version is
a live demonstration that transparent post-quantum verification *runs on Stellar
today* at a stated, lower security level. Neither number is hidden, and the
on-chain figure is not presented as production-grade. Reaching 62 quantum bits
on-chain would require either splitting the verification across transactions or a
larger extension field (new cryptography) — stated, not implied.

## Reproduce

```bash
cd onchain-verifier
cargo test --release --test measure -- --nocapture   # the metered CPU table
stellar contract build --optimize                     # 112 KB wasm
# deploy + invoke are the two txs above; commands in this file's history.
```

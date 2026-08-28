# asp-admitter — KYC-gated, unlinkable entry into an SPP Association Set

Stellar Private Payments (Nethermind, Developer Preview 2026-08-25) enforces
compliance through an **Association Set Provider**: `asp-membership`, a Poseidon2
Merkle tree of approved pool public keys whose root every pool transaction proves
against. The SPP preview says association is "at the key level" so that it is
"easier to KYC-gate entry". What it leaves to the deployer is *how* a key gets
into that tree: today an admin inserts it, off-chain, knowing exactly which
person each pool key belongs to.

This contract is that missing step, without the mapping. It **becomes the admin
of an `asp-membership` instance** and inserts a leaf only after a hash-based
Circle-STARK proof that the requester belongs to the issuer's KYC'd set. The proof
shows *a* member asked, never *which* one, to the public and to the pool
operator. The ASP ends up holding only KYC'd leaves and no leaf-to-person table
outside the KYC issuer. Amount and counterparty privacy stay the pool's job; this
fixes the entry. (A leaf is SPP's pool-side commitment of a note public key,
`Poseidon2(notePubKey, blinding, ds = 1)`; the admitter only requires a BN254
scalar-field element.)

```
requester ──admit(pool_key, stark_proof, publics)──▶ asp-admitter ──insert_leaf(pool_key)──▶ asp-membership (Nethermind)
                                                         │                                        │
                                              verify_crowd_membership                          get_root ──▶ SPP pool
```

## Surface

| fn | behaviour |
|---|---|
| `__constructor(admin, asp, verifier, root, nq, lb, predecessor)` | atomic with deploy; `root` = keccak256 of the issuer set's STARK root; `predecessor` = previous admitter generation whose admissions still count |
| `commit(h)` | step 1: `h = sha256(leaf_be32 ‖ C)`; anyone may commit, a commit only unlocks its own pair |
| `admit(leaf, mem_proof, mem_publics)` | step 2, next ledger or later, no caller auth. Checks in order: `leaf < r` (#7), publics length (#3), issuer root (#4), commit exists (#8) and is older than this ledger (#9), `C` unused here and in the predecessor (#6), STARK verifies (#5). Then `asp.insert_leaf(leaf)` (#10 if the ASP refuses), emits `KeyAdmitted{leaf, asp_root}` |
| `is_used(C)` | one leaf per member commitment, this generation |
| `lock_asp()` | admin only; re-asserts `admin_insert_only = true` on the ASP |
| `set_root(root)` / `set_verifier(verifier, nq, lb)` | admin only; KYC-set epoch rotation and verifier replacement without redeploy (`Used` marks survive) |
| `hand_back_asp_admin(new_admin)` | admin only; returns the ASP to a human or a successor generation |

Why commit-reveal: the STARK binds the member commitment `C` and the set root,
not the leaf. Without it, anyone who saw a proof before inclusion could submit it
with their own leaf and burn the member's admission. With it, `admit` only accepts
a `(leaf, C)` pair committed in an earlier ledger, and `C` is unknown to third
parties until the proof is published. This closes the substitution attack with
no change to the prover.

Nethermind's `insert_leaf` requires the ASP admin's auth; when the admin is this
contract, Soroban satisfies that auth for the contract's own direct call. Nothing
else can insert.

## Live on testnet (2026-08-28), three generations against Nethermind's contract

`asp-membership` built from their repo (`cb79f817`, levels 20), our instance
`CBCNAXUHC45Q57AQNSXZCKADYOMOYXMBYTTVFTJ4GLDSNMVNDD3V53I2`. STARK verifier
`CCXAP4MZUUX5UHBL5MGYMLCHSMRVA3RA4JOCYM7G34LRTTHR67ACYOUC` (same code verified on
mainnet, `CB32KP47…`). Source key `admin`.

| generation | id | what it showed |
|---|---|---|
| A (first cut, no commit step) | `CAA3VHNLGN62B2WG7JVQZ43WF2SZBFFUI3LEMLGV36Y6YXXQG2A4EPH4` | handover [`28c9ebdc…`](https://stellar.expert/explorer/testnet/tx/28c9ebdc880b3f5fd51d4121f89c3b13365d8cb5837dc6d77e0233fffbb62124), admit leaf `123456789` → `LeafAdded{index 1}` [`47566736…`](https://stellar.expert/explorer/testnet/tx/4756673629c890f0e7fefdc8e36237f203d9690e91f4a91f948553d5e30b54e2); replay #6, tampered #5, `leaf = r` #7, old admin key cannot insert |
| B (`predecessor = A`) | `CCVO36NSMNCQJGWGSFTVH3OBDOYIEYX3K2IUH6L4ASYXXCCG5F75S5HK` | A → B [`043ce039…`](https://stellar.expert/explorer/testnet/tx/043ce039cd4179e1cd21fce8906160141f23c51e974f0203cd0fc6fb2981cb51), `lock_asp` [`20718073…`](https://stellar.expert/explorer/testnet/tx/20718073874bbf903d23bee775b4273e83f87f2e0cdf3acfb8cc43f2378fd2ed), commit [`e1d67bd7…`](https://stellar.expert/explorer/testnet/tx/e1d67bd77b6e590acc66dfb65930825242841081023bf9621e45716ca2b1108e), then the historical proof → **#6 CommitmentUsed via predecessor**: a hand-back does not re-open old proofs |
| C (fresh epoch) | `CBVB4BUU52F4AZZCVGORYAWHBTO3OH2D3PDEOY4NA74FRPDXD7GLRKUV` | B → C [`9862abbe…`](https://stellar.expert/explorer/testnet/tx/9862abbe9d0ac64f1cfde1a35c3aaf66b19517d0e968cedb4eb020a80265e09f); admit without commit → #8; commit [`34f84f52…`](https://stellar.expert/explorer/testnet/tx/34f84f522cfb2ed22f30ef1b64f03a784eb2adf988d7a8bca239adcb6d920664); **same proof with an attacker's leaf → #8**; reveal leaf `987654321` → `LeafAdded{index 2}` + `KeyAdmitted`, root `2000…2523` → `2046…7322` [`844eac22…`](https://stellar.expert/explorer/testnet/tx/844eac228402f1b0d8431032b5347aedc7456a5a32fb0292856f6bf64678d0b1); replay → #6 |

Rejections are simulation failures and carry no hash; the scripts under
`scripts/` reproduce them. 17 unit tests (`cargo test`), including the
substitution attack and contract-to-contract auth with no mocked auths, a full
tree reported as #10 with nothing consumed, predecessor honoured across a
hand-back, root rotation with `Used` surviving. Wasm 9.5 KB.

## Limits, stated

- **The KYC issuer can link.** The `admit` transaction carries the member
  commitment `C` next to the leaf. `C` is a leaf of the issuer's set, so the party
  that assembled the set can map `C` to a person. The claim is exact: no
  leaf-to-person mapping exists for the public or for a pool operator that is not
  the KYC issuer. Hiding `C` from the issuer too needs the binding proof
  (unlinkable per-context face + nullifier) instead of the membership proof; next.
- **Two admissions per ledger.** Nethermind's tree writes `FilledSubtrees` by index
  parity, so concurrent admits collide on the footprint and the later one fails at
  apply (fee paid, nothing consumed, commit still valid: retry). Batching is a
  follow-up.
- **Keep the chain alive.** The admitter extends its own instance TTL on every
  call; the verifier and the ASP are separate contracts and must be kept alive by
  their operators (runbook item, not fixable from here).
- **Runbook, not code:** after `asp.update_admin(admitter)`, call `lock_asp()`;
  the admitter cannot read the ASP's insert-only flag (no getter in `asp-membership`).
- Not audited. Not wired to a live SPP pool yet: SPP's testnet pools point at
  Nethermind's own ASP instance, whose admin they hold. Wiring is one
  `update_admin` on their side, or a pool deployed against this instance.
- Side finding for Nethermind while building: `soroban-utils::MockToken` is not
  `cfg(test)`-gated and ships inside the production wasm of `asp-membership`,
  `asp-non-membership` and the pool (5 no-op token exports). Reported as
  [NethermindEth/stellar-private-payments#528](https://github.com/NethermindEth/stellar-private-payments/issues/528).

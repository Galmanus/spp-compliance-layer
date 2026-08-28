# asp-admitter — KYC-gated, unlinkable entry into an SPP Association Set

Stellar Private Payments (Nethermind, Developer Preview 2026-08-25) enforces
compliance through an **Association Set Provider**: `asp-membership`, a Poseidon2
Merkle tree of approved pool public keys whose root every pool transaction proves
against. The SPP preview says association is "at the key level" so that it is
"easier to KYC-gate entry". What it leaves to the deployer is *how* a key gets
into that tree: today an admin inserts it, off-chain, knowing exactly which
person each pool key belongs to.

This contract is that missing step, without the mapping. It **becomes the admin
of an `asp-membership` instance** and inserts a pool key only after a hash-based
Circle-STARK proof that the requester belongs to the issuer's KYC'd set. The proof
shows *a* member asked, never *which* one. The ASP ends up holding only KYC'd keys
and no pubkey-to-person table. Amount and counterparty privacy stay the pool's
job; this fixes the entry.

```
requester ──admit(pool_key, stark_proof, publics)──▶ asp-admitter ──insert_leaf(pool_key)──▶ asp-membership (Nethermind)
                                                         │                                        │
                                              verify_crowd_membership                          get_root ──▶ SPP pool
```

## Surface

| fn | behaviour |
|---|---|
| `init(admin, asp, verifier, root, nq, lb)` | one-shot config; `root` = keccak256 of the issuer set's STARK root |
| `admit(leaf, mem_proof, mem_publics)` | no caller auth (the proof is the credential). Checks, in order: `leaf < r` (BN254 scalar field, #7), publics length (#3), issuer root (#4), commitment unused (#6), STARK verifies (#5). Then `asp.insert_leaf(leaf)`, emits `KeyAdmitted{leaf, asp_root}` |
| `is_used(commitment)` | one admission per member commitment |
| `hand_back_asp_admin(new_admin)` | issuer admin only; returns the ASP to a human or a new admitter, so this contract can never brick the tree |

Nethermind's `insert_leaf` requires the ASP admin's auth; when the admin is this
contract, Soroban satisfies that auth for the contract's own direct call. Nothing
else can insert.

## Live on testnet (2026-08-28)

Nethermind's `asp-membership` built from their repo (`cb79f817`, levels 20), fresh
instance, admin handed to the admitter:

| piece | id / tx |
|---|---|
| `asp-membership` (Nethermind, our instance) | `CBCNAXUHC45Q57AQNSXZCKADYOMOYXMBYTTVFTJ4GLDSNMVNDD3V53I2` |
| **asp-admitter** | `CAA3VHNLGN62B2WG7JVQZ43WF2SZBFFUI3LEMLGV36Y6YXXQG2A4EPH4` |
| STARK membership verifier (existing) | `CCXAP4MZUUX5UHBL5MGYMLCHSMRVA3RA4JOCYM7G34LRTTHR67ACYOUC` |
| `asp.update_admin(admitter)` | [`28c9ebdc…`](https://stellar.expert/explorer/testnet/tx/28c9ebdc880b3f5fd51d4121f89c3b13365d8cb5837dc6d77e0233fffbb62124) |
| `admit(123456789, 82 KB proof)` → `LeafAdded{index 1}` + `KeyAdmitted`, root `1796…4855` → `2000…2523` | [`47566736…`](https://stellar.expert/explorer/testnet/tx/4756673629c890f0e7fefdc8e36237f203d9690e91f4a91f948553d5e30b54e2) |
| old admin key `insert_leaf` after handover | rejected (auth) |
| same proof, second key | rejected `#6 CommitmentUsed` |
| tampered proof | rejected `#5 MembershipRejected` |
| `leaf = r` | rejected `#7 LeafOutOfField` |

Rejections are simulation failures and carry no hash; re-run `scripts/` to
reproduce. 10 unit tests (`cargo test`), including contract-to-contract auth with
no mocked auths. Wasm 5.5 KB.

## Limits, stated

- **Proof not bound to the pool key.** The STARK binds the member commitment and
  the set root, not the leaf. The single-use mark closes replay of a published
  proof, but a party who sees a proof before inclusion could race it with its own
  key and burn that member's admission. Full fix: the pool key inside the proof's
  publics (prover change, tracked as F16 across Vineland).
- Not audited. The STARK verifier is the same one verified on Stellar mainnet
  (`CB32KP47…`, tx `9f776be5…`); this contract is new.
- Not wired to a live SPP pool yet: SPP's testnet pools point at Nethermind's own
  ASP instance, whose admin they hold. Wiring is one `update_admin` on their side,
  or a pool deployed against this instance.
- Side finding for Nethermind while building: `soroban-utils::MockToken` is not
  `cfg(test)`-gated and ships inside the production `asp_membership.wasm` (5 extra
  token-shaped exports).

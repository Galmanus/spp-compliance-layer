# Submission — Enterprise, Compliance & RWA lane

**Lane:** Enterprise, Compliance and RWA (Privacy · OpenZeppelin + Nethermind).
**Repo:** <https://github.com/Galmanus/spp-compliance-layer> · MIT.
**Same codebase as our Confidential-Token & Private-Payment Wallets submission,
framed here for the compliance/enterprise angle — one real project, honestly
addressing both.**

---

## What we built, for this lane

A **post-quantum compliance layer** for regulated privacy pools on Stellar, and a
**policy-gated confidential payment** built on it. It maps directly onto this
lane's own example — *"B2B confidential settlement … a policy-gated confidential
payment demo"* — and does it with cryptography an enterprise can still trust after
the quantum transition.

The policy is a compliance root: an Association Set Provider (ASP) publishes a
Merkle root over an approved set (the allow-list / identity policy). Our three
pieces make that policy **enforceable and durable**:

1. **A post-quantum attestation** that the compliance root history is a gap-free,
   honestly-ordered append-only sequence — a hash-based Circle-STARK, no trusted
   setup, verified **on-chain** in a Soroban contract.
2. **A compliance gate** — `admit_root` records a root as policy-valid on-chain
   *only if* the post-quantum proof verifies. No proof, no admitted policy.
3. **A policy-gated pool** — `spend` settles a confidential payment **only against
   an admitted compliance root** (cross-contract `is_attested`). Present a root
   the policy never admitted, and the chain refuses the payment.

That is a confidential payment whose settlement is gated on a compliance policy —
their example #2 — with the policy itself proven honest by post-quantum
cryptography and checkable on-chain.

## Live on Stellar testnet (click to verify)

| | receipt |
|:--|:--|
| Policy admitted only on a valid PQ proof | tx [`a2c3227c…`](https://stellar.expert/explorer/testnet/tx/a2c3227c0bc372c0a69065fc29fdb6c50d4732fec664f34df42c29d71b3142b8) (gate `CCFYA7GQ…`) |
| Confidential payment settles only against the admitted policy | tx [`255db58d…`](https://stellar.expert/explorer/testnet/tx/255db58d1d3879f615b4e847c86cfb98a070962801acfee7338de11c57019413) (pool `CDGQQW4V…`) |
| Un-admitted policy / tampered proof | **refused on-chain** |

Query it yourself: [`VERIFY-IT-YOURSELF.md`](VERIFY-IT-YOURSELF.md).

## Why this matters for enterprise / RWA

Regulated and real-world assets have **long lifetimes** — a compliance record must
outlive the data it certifies. A regulator or counterparty in 2035 has to be able
to check that a 2026 approval set was built honestly, long after a quantum
computer could forge a BN254 (Groth16 / UltraHonk) proof. Every ZK compliance
proof on Stellar today is pairing-based and Shor-breakable; the SDF says there is
no drop-in post-quantum replacement. Ours is hash-based — a quantum computer only
weakens it (Grover), never breaks it (Shor). For enterprise compliance, that is
the difference between an audit trail that survives the quantum transition and one
that does not.

It also **completes a component the ecosystem already ships**: Nethermind's SPP
client hands compliance-history sync to a `bootnode_url` whose own docs name
forged-history and selective-omission as unmitigated trust risks. We are that
bootnode, trust-minimized — an enterprise points its wallet at it and gets a
completeness proof plus a post-quantum compliance attestation, not a "trust the
provider" promise. See [`docs/VERIFIABLE-BOOTNODE.md`](docs/VERIFIABLE-BOOTNODE.md).

## Honest scope — what we are, and are not

- **We are** a post-quantum compliance layer and a policy-gated confidential
  payment (this lane's example #2), with on-chain receipts and a completeness
  proof — grounded in Privacy Pools (Buterin et al).
- **We are not** an RWA token issuer or a sealed-bid auction (this lane's other
  examples). We are the compliance/policy infrastructure those would gate on.
- **The compliance attestation proves the append-only index STRUCTURE over
  witnessed roots**, meaningful to a verifier who knows the endpoints (readable
  on-chain); the completeness binding is the coverage proof. We state this
  precisely rather than overclaim — [`docs/LAYER3-DESIGN.md`](docs/LAYER3-DESIGN.md).
- **On-chain security** is 24 quantum-bits at the one-transaction budget (62
  off-chain); named, not hidden — [`docs/SECURITY.md`](docs/SECURITY.md).

## Start here

- The 60-second map: [`SUBMISSION.md`](SUBMISSION.md)
- On-chain verification + receipts: [`docs/ONCHAIN-VERIFICATION.md`](docs/ONCHAIN-VERIFICATION.md)
- Whitepaper (PDF): [`docs/whitepaper/whitepaper.pdf`](docs/whitepaper/whitepaper.pdf)
- Run it in one command: `npm install && bash demo.sh`

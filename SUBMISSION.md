# Submission — a verifiable bootnode for Stellar Private Payments

**Lane:** Confidential-Token & Private-Payment Wallets (Privacy · OpenZeppelin +
Nethermind), *ecosystem-infrastructure* sub-heading.
**Repo:** <https://github.com/Galmanus/spp-compliance-layer> · MIT.

> **Positioning.** This is not a competing wallet — it is the infrastructure the
> lane's wallets depend on. A private-payment wallet is only as trustworthy as the
> history it rebuilds from and the association set it proves against; both are
> exactly what this layer secures. Every wallet built in this lane can point its
> `bootnode_url` here and gate its compliance on the same post-quantum attestation.
> We win by making the *other* teams' wallets trustworthy, not by out-featuring
> them.

---

## In one sentence

A private-payment wallet's balance depends on history a Stellar RPC deletes in
**7.02 days**; Nethermind's client hands that history off to a *bootnode* its own
docs call an unmitigated trust risk. This is that bootnode, made trust-minimized
— it audits the primitives, proves the history complete, and attests it honest
with a **post-quantum STARK verified on-chain** — and the attestation is
**load-bearing**: on Stellar, a compliance root is admitted, and a pool spends,
*only if* the proof holds.

## The headline (all on Stellar testnet, with receipts)

A transparent, hash-based Circle-STARK — proving the ASP compliance root history
is an honest append-only chain — verified **natively on-chain**, and gating state:

| | receipt |
|:--|:--|
| Gate admits a root only on a valid proof | tx [`a2c3227c…`](https://stellar.expert/explorer/testnet/tx/a2c3227c0bc372c0a69065fc29fdb6c50d4732fec664f34df42c29d71b3142b8) (contract `CCFYA7GQ…`) |
| A pool spends only against an admitted root | tx [`255db58d…`](https://stellar.expert/explorer/testnet/tx/255db58d1d3879f615b4e847c86cfb98a070962801acfee7338de11c57019413) (contract `CDGQQW4V…`) |
| Tampered proof / un-admitted root | rejected on-chain, no state change |
| Cost | 260M instructions (65% of one tx), 115 KB wasm |

The loop, both sides on-chain: **STARK proves history honest → gate admits the
root → pool consults the gate before it spends.** No attestation, no admitted
root; no admitted root, no spend.

## The three layers

1. **Audit** — `sorohunter` executes against the real deployed WASM (a finding is
   an executed run, never an inference). Ran on *both* sponsors' primitives — the
   SPP pool and the OZ Confidential-Token verifier — and reports exactly what it
   reached. No invented findings.
2. **Durable bootnode** — captures pool + ASP events past the 7-day window and
   *proves completeness* (coverage intervals, gaps reported not hidden). Speaks
   the SPP client's exact JSON-RPC surface, proven byte-for-byte against the
   client's own struct, so an unmodified wallet can point `bootnode_url` at it.
   Closes the forged-history / selective-omission / misleading-handoff risks
   Nethermind's bootnode docs leave open.
3. **Post-quantum attestation** — the Circle-STARK above. Off-chain at 62 quantum
   bits (the QM31 field ceiling); on-chain at 24 quantum bits (one-tx CPU cap),
   with recursion — the sponsor's own STARKPack technique — as the stated scaling
   path to lift the on-chain figure.

## Alignment with the SDF's current priorities

- **Post-quantum:** a transparent, hash-based STARK verified natively on-chain —
  the ZK layer the SDF's Quantum Preparedness Plan names as the open problem.
- **Privacy:** the compliance layer for Nethermind's SPP and OpenZeppelin's
  Confidential Token, grounded in Privacy Pools (Buterin et al).
- **Agentic payments:** the gate composes with Stellar's agent payment rails
  (x402 / MPP) as a post-quantum compliance precondition — an agent settles a
  private payment only if `is_attested(root)` holds. Stated as composition, not a
  shipped agent demo. See [`docs/AGENTIC-PAYMENTS.md`](docs/AGENTIC-PAYMENTS.md).

## What we do NOT claim (stated first, not hidden)

- **Not first at on-chain ZK on Stellar** (that is common, all BN254). The narrow
  claim is: first *transparent, hash-based* STARK verified *natively* on-chain —
  not wrapped in a BN254 seal like RISC Zero — and first wired into compliance.
  See [`docs/RELATED-WORK.md`](docs/RELATED-WORK.md).
- **The attestation is post-quantum; the SPP/OZ privacy proofs are not** — they
  are BN254, and the SDF states no drop-in PQ replacement exists. We attest the
  compliance record, which we can; we do not claim to make their privacy PQ.
- **On-chain security is 24 quantum bits** at the shipped 40 queries — below a
  128-bit target, and named as a demonstration at the field ceiling, not
  production-grade. The 62-bit version runs off-chain.
- **The attestation proves history STRUCTURE, not hash preimage** — a Poseidon2
  collision is the pool's assumption, not this layer's to remove.
- **An earlier draft over-stated the security figure** (92/46); we recomputed it
  against the real config, corrected it to 124/62, and left the correction
  visible. We audited our own repo for mocks — there are none.

## Verify it yourself

```bash
git clone https://github.com/Galmanus/spp-compliance-layer
cd spp-compliance-layer && npm install && npm test        # 31 JS tests
cd attestation && cargo test --release                    # 15 Rust tests (attestation + gate + pool)
cd ../onchain-verifier && cargo test --release --test measure -- --nocapture
                                                          # metered on-chain CPU
```

## Read more

- **Whitepaper (PDF):** [`docs/whitepaper/whitepaper.pdf`](docs/whitepaper/whitepaper.pdf)
- **On-chain verification + receipts:** [`docs/ONCHAIN-VERIFICATION.md`](docs/ONCHAIN-VERIFICATION.md)
- **Verifiable bootnode (attack-vector map):** [`docs/VERIFIABLE-BOOTNODE.md`](docs/VERIFIABLE-BOOTNODE.md)
- **Related work + the precise claim:** [`docs/RELATED-WORK.md`](docs/RELATED-WORK.md)
- **References + cryptographic grounding:** [`docs/REFERENCES.md`](docs/REFERENCES.md)
- **Threat model (Privacy Pools risks → coverage):** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
- **Composition with agentic payments (x402/MPP):** [`docs/AGENTIC-PAYMENTS.md`](docs/AGENTIC-PAYMENTS.md)
- **Evidence (every number, reproduced):** [`docs/EVIDENCE.md`](docs/EVIDENCE.md)
- **Security accounting:** [`docs/SECURITY.md`](docs/SECURITY.md)

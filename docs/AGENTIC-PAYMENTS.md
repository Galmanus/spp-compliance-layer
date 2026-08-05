# Composition with agentic payments

Stellar's current priorities cluster on three fronts: post-quantum readiness,
privacy, and agentic (machine-to-machine) payments. This project is squarely on
the first two — a post-quantum attestation of a privacy pool's compliance
history, verified on-chain. This note is honest about the third: we do not build
an agent payment rail, but the compliance gate **composes** with one, and the
composition is a real cross-contract call, not a slogan.

## The gate is a compliance precondition any payer can check

`is_attested(root_key)` is a boolean, cheap, read-only call: *has this compliance
root been admitted by a valid post-quantum proof of an honest history?* The
`guarded-pool` already demonstrates one consumer of it — a spend that the chain
refuses unless the root is attested (tx `255db58d…`). An agent payment rail is
simply another consumer of the same precondition.

## How an agent payment gates on it

Stellar's agentic-payment protocols — x402 (with the OpenZeppelin Channels
facilitator) and the Machine Payments Protocol (MPP) — settle a payment from an
AI agent to a resource server over Soroban. Neither says anything about whether
the agent's funds are *compliant*. That is exactly the gap this layer fills:

```
agent  --x402/MPP payment-->  facilitator / SAC transfer
   |                                  ^
   | before settling, check          | only settle if
   v                                  | is_attested(compliance_root) == true
compliance gate  is_attested(root) --/   (a valid post-quantum proof admitted it)
```

Concretely, an x402 resource server (or the facilitator) adds one gate call to
its verify step: before honouring the agent's payment, it calls
`is_attested(compliance_root)` on the gate contract. If the association-set root
the agent's funds prove membership in has not been post-quantum-attested as an
honest append-only history, the payment does not settle. The agent's money moves
only against compliance that is proven, not asserted — and proven with
post-quantum, trusted-setup-free cryptography.

This is the same gate-consumption pattern the `guarded-pool` proves on-chain,
moved to the payment layer. The payment rail is the existing Stellar protocol
(x402/MPP); the post-quantum compliance precondition is this project. We state
this as composition and design, not as a shipped agent demo: the on-chain proof
that the pattern works is the pool's `spend`, and wiring an x402 facilitator's
verify step to the same `is_attested` call is a small, obvious integration on top.

## Why it matters

As agents transact autonomously, "are these funds compliant?" becomes a question
a machine must answer without a human in the loop — and the answer must be
verifiable, not trusted. A post-quantum, on-chain compliance gate is the kind of
primitive that lets an agentic payment carry a compliance signal that survives
both a hostile counterparty and a future quantum adversary. That is the honest
intersection of all three SDF priorities in one call: an **agent** making a
**private** payment, gated on a **post-quantum** compliance proof.

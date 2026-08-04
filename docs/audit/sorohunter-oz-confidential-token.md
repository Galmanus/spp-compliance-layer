# sorohunter against the OpenZeppelin Confidential Token — first pass

The lane names two sponsors. The durable-index and attestation layers address
the Nethermind SPP side; Layer 1 (audit) is not primitive-specific, so the same
fork-validated discipline is turned on the OTHER primitive in the lane — the
OpenZeppelin Confidential Token (UltraHonk over BN254, `stellar-tokens`
`feat/confidential-verifier-ultrahonk`).

Tool: [sorohunter](https://github.com/Galmanus/sorohunter), fork-validated — a
finding is an executed invocation sequence against the real deployed WASM in a
local `soroban-sdk` fork, never an inference. The live network is never touched.

Targets (testnet, from the demo's own `deployment.ts`):

- token: `CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F`
- verifier: `CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL`

## What ran

### Token — 11 probes, all deploy-failed

```
CBF64DEO...: 11 probes
  [deploy-failed] merge / deposit / register / withdraw
  [deploy-failed] is_spender / set_spender / revoke_spender
  [deploy-failed] confidential_balance / confidential_transfer
  [deploy-failed] get_spender_delegation / confidential_transfer_from
```

Every probe fails to deploy for the same reason as the SPP pool: the constructor
wires the token to a verifier, an auditor, and an underlying SAC
(`token/lib.rs:39` `__constructor(underlying_asset, verifier, auditor)`), and the
generic engine cannot synthesize those cross-contract dependencies. No finding,
reported as no finding.

### Verifier — 17 probes: 13 deploy-failed, 4 skipped

```
CDCET36P...: 17 probes
  [deploy-failed] has_role / grant_role / revoke_role / renounce_role
  [deploy-failed] get_admin / set_role_admin / transfer_admin_role / ...   (AccessControl)
  [skipped] verify_proof(CircuitType, bytes, bytes)
  [skipped] get_verification_key(CircuitType)
  [skipped] update_verification_key(CircuitType, bytes, address)
  [skipped] register_verification_key(CircuitType, bytes, address)
```

The 13 deploy-failed are the `AccessControl` role surface. The 4 skipped are the
entire soundness-critical surface — every one takes a `CircuitType` UDT the
generic fuzzer does not fabricate. As with the SPP pool's `transact(Proof, ...)`,
the security-critical path is reachable only by something that can construct the
circuit type and a real UltraHonk proof: proof-aware, not proof-blind.

## Directed reading of the surface the engine cannot reach

The deployed verifier contract (`contracts/verifier/src/lib.rs`, 61 lines) is a
thin wrapper over `stellar_tokens::confidential::verifier`:

- Contract-level access control is correct: `register_verification_key` and
  `update_verification_key` are both gated `#[only_role(operator, "manager")]`
  (`lib.rs:43,48`), so VK management requires the manager role and that
  operator's auth. `verify_proof` / `get_verification_key` use the trait
  defaults, which run the UltraHonk backend.

- The soundness-critical logic is NOT in this contract. It is in OpenZeppelin's
  `stellar-tokens` library and the `NethermindEth/rs-soroban-ultrahonk` backend.
  OpenZeppelin's own header comment flags this explicitly (`lib.rs:10-16`):
  *"Not Production Ready ... the UltraHonk backend and the circuits the keys are
  derived from are unaudited. `update_verification_key` is soundness-critical: a
  wrong key makes the verifier accept forged proofs."* The contract gates it
  behind the manager role "purely for demo convenience".

## The verdict, and why it matters for this lane

No finding — reported as no finding. What the two runs establish, by execution,
is structural and it is the same on both sponsors' primitives:

- The SPP pool's value path (`transact`) is behind a **Groth16** proof.
- The OZ Confidential Token's verification path (`verify_proof`) is behind an
  **UltraHonk** proof.

Both are unreachable by a generic fuzzer, and both are self-described by their
authors as unaudited works in progress. A privacy wallet in this lane is built
on exactly these two primitives, and the only tooling that can audit their
critical paths is proof-aware. That is precisely the position this project takes:
the audit layer is proof-aware where it can be, and where it cannot yet drive the
prover, it says so — never claiming a path it did not execute.

## Reproduce

```bash
git clone https://github.com/Galmanus/sorohunter && cd sorohunter
python3 -m sorohunter.cli scan CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F --network testnet
python3 -m sorohunter.cli scan CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL --network testnet
```

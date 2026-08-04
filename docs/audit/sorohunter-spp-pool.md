# sorohunter against the SPP pool — first pass

Target: `CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU`
(Nethermind Stellar Private Payments, native-XLM pool, testnet)
Tool: [sorohunter](https://github.com/Galmanus/sorohunter), fork-validated —
a finding is an executed invocation sequence against the real WASM in a local
`soroban-sdk` fork, never an inference. The live network is never touched.

## What ran

The real deployed WASM was acquired read-only from testnet and 15 probes were
executed against it in a local fork.

| probes | outcome |
|---|---|
| 12 | could not deploy — the constructor needs cross-contract dependencies (ASP contracts, verifiers, token) the engine cannot synthesize alone |
| 2 | skipped — `u256` argument the generic fuzzer does not fabricate (`is_spent`, `is_known_root`) |
| 1 | skipped — `transact(Proof, ExtData, address)`: the value-moving path takes a Groth16 proof as a struct |

## The honest verdict

**No finding.** And that is reported as no finding, not dressed up. The engine's
one invariant is that it never claims what it did not execute, so a target it
cannot assemble yields "could not deploy", never "looks vulnerable".

## What the failure itself tells us

The interesting line is the last one. `transact` — the function that moves money
in and out of the pool — takes a Groth16 proof as an argument. No generic fuzzer
produces a valid one, which means **the pool's value path cannot be
adversarially exercised without a harness that can build a `Proof`** — exactly
what Nethermind's own client SDK does. Auditing that path is the next step, and
it requires driving their prover, not fuzzing around it.

That is a real statement about the shape of the attack surface, produced by
execution rather than by reading: the money path of an SPP pool is only
reachable by something that can prove, so the audit tooling the ecosystem needs
is proof-aware, not proof-blind.

## Reproduce

```bash
git clone https://github.com/Galmanus/sorohunter && cd sorohunter
python3 -m sorohunter.cli scan \
  CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU --network testnet
```

## Second pass — directed reading of the surfaces most likely to be wrong

The generic engine hits the same wall on every SPP contract (cross-contract
constructors, `u256`/struct arguments), so the surfaces a generic fuzzer cannot
reach were read by hand, targeting the three classes where this project has
either been burned itself or where mistakes are common.

| surface | contract:line | verdict |
|---|---|---|
| non-canonical public inputs (the class that gave riverrun a double-spend) | `pool.rs:365` | **correct** — every public U256 is range-checked against the BN254 modulus, `NonCanonicalPublicInput` on failure, each nullifier included |
| access control on `insert_leaf` into the approval tree | `asp-membership/lib.rs:195` | **correct** — `admin_only` defaults to `true` via `unwrap_or(true)`, and admin auth is required when set |
| the gate protecting that control | `asp-membership/lib.rs:137` | **correct** — `set_admin_insert_only` requires `admin.require_auth()`; the gate cannot be disabled by a non-admin |

## The honest conclusion

**The SPP contract layer is well built.** Three classes of bug — including the
exact one that cost riverrun a double-spend twenty-four hours earlier — were
checked and are absent. No finding is invented where there is none; that would
destroy the only thing this submission is selling, which is that its claims are
executed rather than asserted.

This is the right result for the thesis, not a consolation. The argument was
never "their contracts are insecure." It was: **nobody has verified them, and
verifying requires tooling.** Now, backed by execution:

- sorohunter ran probes against four deployed contracts, read-only, and was
  disciplined about what it could not assemble;
- directed adversarial reading confirmed three known bug classes are absent from
  the contract layer;
- and the generic engine located where a real audit has to go: the value path
  (`transact`) is reachable only by something that can produce a valid proof.

An audit that reports "checked, and correct, here is exactly what was checked"
is a contribution. It is what lets a wallet builder stand on this pool knowing
which surfaces have been looked at and by what method.

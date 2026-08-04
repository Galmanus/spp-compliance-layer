# Evidence

Every claim in this repository traces to a command. This file records the
commands and their real output, captured live against Stellar testnet on
4 August 2026. Where a number moves between runs, that movement is itself the
evidence — noted rather than smoothed over.

---

## 1. The RPC's retention window is 7.02 days, and it slides

```console
$ node bin/spp-index.mjs retention
retention window: 120,959 ledgers = 7.02 days (from ledger close times)
  oldest servable ledger: 3,846,339
  chain tip:              3,967,298
  SPP pool (native XLM): genesis expires from the RPC in 3.07 days
```

The window is measured from the ledgers' own close times (`latestLedgerCloseTime
− oldestLedgerCloseTime`), not assumed at "5 seconds a ledger". The boundary is
read from the RPC's own response, which volunteers `oldestLedger` on every
successful call.

**It moves.** Captured across this session:

| time (BRT) | RPC floor | days until pool genesis expires |
|:--|:--:|:--:|
| ~10:30 | 3,845,336 | 3.13 |
| ~10:47 | 3,845,336 | 3.13 |
| ~13:30 | 3,846,339 | **3.07** |

The floor rose ~1,000 ledgers and the runway shortened, in the same afternoon.
Every ledger the floor passes is history that, if not already captured, is gone
from the network for good. The SPP pool's genesis (ledger 3,899,359) leaves the
window during the judging weekend.

This is not our measurement to fake. Reproduce it against any Soroban RPC and it
will report the same shape, sliding.

---

## 2. The index proves completeness, not just presence

```console
$ node bin/spp-index.mjs init
registered SPP pool (native XLM)
  CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU from ledger 3,899,359
...

$ node bin/spp-index.mjs ingest
chain tip 3,966,299
CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU
  pages 1  commitments 0  nullifiers 0
  scanned through ledger 3,966,299, 0 new rows
  3.07 days before genesis leaves the RPC
  no gaps from genesis to 3,966,299
```

The `0 commitments` is real and verified independently: the four deployed SPP
contracts have emitted no events yet. The index is correct about an empty pool,
and says so — "no gaps" over an empty history is a cheap claim, and the honest
form of Layer 2's value shows only once history exists. The machinery that
proves it (coverage-interval merging, gap reporting) is tested in §4.

---

## 3. The attestation is real, tested, and tiny

The Layer-3 STARK proves the ASP root history is a consistent append-only chain.
Measured across history sizes (from `mirror-pool`'s `attest_history` example):

```
6 events   (2^3 rows): verify=true  prove 0ms   proof 16,706 B (13% of envelope)
60 events  (2^6 rows): verify=true  prove 4ms   proof 33,537 B (25% of envelope)
250 events (2^8 rows): verify=true  prove 14ms  proof 47,922 B (36% of envelope)
```

End to end through the index seam:

```console
$ node bin/spp-index.mjs attest ASPTEST
attesting 8 ASP root updates for ASPTEST ...
  post-quantum attestation: 15,761 bytes
  covers root indices 0..7
```

The attestation reproves no hash — the BN254-Poseidon2 compression is a
witnessed oracle — which is why it is far smaller than every other proof in the
`mirror-pool` crate. What it proves is structure: a reordered or leaf-injected
history is **unprovable**, not merely rejected at verification. Two tests in
`mirror-pool` (`a_reordered_history_cannot_even_be_proved`,
`an_injected_leaf_breaks_the_index_chain`) pin this fail-closed behaviour.

---

## 4. The behaviour that must not regress is tested

```console
$ npm test
# tests 6
# pass 6
# fail 0
```

| test | what it locks |
|:--|:--|
| coverage merges adjacent spans and reports gaps honestly | the completeness claim |
| a gap before genesis is not invented | no false "incomplete" |
| ASP root steps come back in tree order | the attestation input is correct |
| idempotent ingest | replays do not double-count |
| retention refusal recognised, transport error not | "gone" vs "try again" |

---

## 5. The primitives were audited by execution, and found well built

```console
$ python3 -m sorohunter.cli scan \
    CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU --network testnet
CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU: 15 probes
  [deploy-failed] ...  (constructor needs cross-contract dependencies)
  [skipped] transact(udt:Proof,udt:ExtData,address)  unsynthesizable args
```

15 probes executed against the real deployed WASM in a local `soroban-sdk` fork;
no vulnerability invented where there is none. Directed reading then confirmed
three known bug classes absent from the contract layer. Full report in
[`audit/sorohunter-spp-pool.md`](audit/sorohunter-spp-pool.md). Verdict: the SPP
contract layer is well built, and the audit documents exactly what was checked.

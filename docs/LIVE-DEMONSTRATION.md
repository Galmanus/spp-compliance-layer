# Live demonstration: real history, captured and attested

The deployed Nethermind SPP contracts have emitted no events, so "durable index"
and "attestation" risked being correct-about-nothing. To demonstrate the whole
pipeline on real on-chain data, we deployed a real ASP membership contract —
Nethermind's own `asp-membership` contract, unmodified — inserted real leaves,
and ran all three layers against the events it emitted.

This is not a mock. It is the SPP compliance primitive, deployed and used, with
every step reproducible from the transaction record.

## What was done, on Stellar testnet

**1. Deployed the ASP** (Nethermind's `asp-membership`, built from
`contracts/asp-membership`, unmodified):

```
ASP contract: CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR
admin:        GDTYZI7AXPRCT32FDATJA2N5ZY4SYKS5FHIVH63ZN3GXQRI563BLOB47
levels:       10  (a 2^10-leaf approval tree)
```

**2. Inserted fifteen leaves** over the demonstration window, each an on-chain
`insert_leaf` that emitted a real `LeafAdded(leaf, index, root)` event
(asp-membership `lib.rs:239`). First event at ledger 3,968,328; the tree now
carries indices 0..14, current root
`4310839444774630776509186067998916458752727384918121419012860917229327270300`.

**3. The index captured all fifteen** — real events, decoded from the RPC's
JSON-XDR form (topic symbol `LeafAdded`, value map `{index:u64, leaf:u256,
root:u256}`), each u256 canonicalized to one decimal representation:

```console
$ node bin/spp-index.mjs ingest
  CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR
  scanned through ledger 3,969,521, 3 new rows
  no gaps from genesis to 3,969,521
```

**4. The STARK attested that real history, and a verifier accepted it:**

```console
$ node bin/spp-index.mjs attest CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR
  attesting 15 ASP root updates ...
  post-quantum attestation: 21,688 bytes
  covers root indices 0..14

$ verify-asp-history attestation.postcard 0 <first_root> <last_root> 15
  VALID: an honest append-only chain of 15 root updates ending at the attested
  root. No trusted setup was involved and no quantum adversary can forge the
  ordering.
```

**5. One flipped bit in the attested root is rejected:**

```console
$ verify-asp-history attestation.postcard 0 <first_root> <last_root^1> 15
  INVALID: this attestation does not verify against those public values. The
  history is not the append-only chain claimed, or the roots do not match.
```

**6. The bootnode serves that real history, and the canonical Stellar codec
decodes it.** With the handoff cutoff set to an operator's window depth, the
index serves the 15 captured events over the same JSON-RPC `getEvents` surface
Nethermind's client speaks — as base64-XDR ScVals, decoded here by
`@stellar/stellar-base` (the codec their client uses):

```console
$ BOOTNODE_CUTOFF_LEDGERS=100 node bin/spp-index.mjs serve 8792 &
$ curl -s -X POST localhost:8792 -d '{"method":"getEvents",...,"startLedger":3968000}'
  envelope: events,latestLedger,latestLedgerCloseTime,oldestLedger,oldestLedgerCloseTime,cursor
  events: 15 | cursor: string | oldestLedger: 3848861
  [0]  LeafAdded idx=0  root=966723695875..
  [1]  LeafAdded idx=1  root=118528746064..
  ...
  [14] LeafAdded idx=14 root=431083944477..
```

Every event round-trips through the canonical SDK to the exact `{index, leaf,
root}` the wallet expects. The serve path today needs the cutoff override only
because these events are still young enough for the main RPC; once the real
window slides past ledger 3,968,328 during the judging weekend, the default
cutoff serves them with no override. See
[VERIFIABLE-BOOTNODE.md](VERIFIABLE-BOOTNODE.md).

## Why this matters

The argument was never hypothetical, and now it is not demonstrated on synthetic
data either. A real ASP published a real root history; the index captured it —
history the RPC will delete in seven days — and the post-quantum STARK proved it
is an honest append-only chain, verifiable by a regulator in 2035 without the
trusted setup or the quantum expiry the Groth16 roots carry.

The bug this exercise caught and fixed: the index must request the RPC's
`xdrFormat: "json"` and read the event's `u64` index field — real events do not
arrive in the shape a first draft assumed. Found by running against the chain,
not by reading. Reproduce every step from the contract ID above.

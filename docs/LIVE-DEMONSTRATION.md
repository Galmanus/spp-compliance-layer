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

**2. Inserted five leaves**, each an on-chain `insert_leaf` that emitted a real
`LeafAdded(leaf, index, root)` event (asp-membership `lib.rs:239`). First event
at ledger 3,968,328, tx `b86792b2…`.

**3. The index captured all five** — real events, decoded from the RPC's JSON-XDR
form (topic symbol `LeafAdded`, value map `{index:u64, leaf:u256, root:u256}`):

```console
$ node bin/spp-index.mjs ingest
  asp roots captured: 5 | rows written: 5
  history: index 0..4, roots 9667236958.., 1185287460.., 2719213467.., 7184735220.., 3450007193..
```

**4. The STARK attested that real history:**

```console
$ node bin/spp-index.mjs attest CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR
  attesting 5 ASP root updates ...
  post-quantum attestation: 16,761 bytes
  covers root indices 0..4
  → append-only chain proven. No trusted setup, no quantum expiry.
```

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

# The retention window, observed over time

`docs/retention-timeseries.jsonl` is a git-versioned series of live observations
of the Soroban RPC's retention floor. Each row is one run of `spp-index track`.

The point is not any single number — it is the **slope**. Committed over time,
this file is git-verifiable proof that:

1. the RPC serves a fixed ~7-day window (`chain_tip − rpc_floor` ≈ 120,959
   ledgers, constant);
2. the floor rises with every ledger, so the window slides;
3. the SPP native pool's genesis (ledger 3,899,359) is being overtaken by that
   floor, and `days_until_pool_genesis_lost` counts down toward zero.

When `ledgers_of_runway` goes negative, the pool's genesis has left the RPC's
reach: no wallet can rebuild its balance from that pool without an index that
captured the history first. On current numbers that crossing happens during the
judging window.

## Reproduce it yourself

```bash
node bin/spp-index.mjs track     # appends one observation
cat docs/retention-timeseries.jsonl
```

Compare any row against the RPC live — the floor is not ours to set, and it will
be at least as high as the last row recorded, never lower. The window only
forgets; it never remembers.

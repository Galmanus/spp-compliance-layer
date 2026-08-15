# Verify it yourself

Do not take this repository's word for anything. Every load-bearing claim is
checkable through systems this project does not control: the public Stellar
ledger, the official Stellar SDK, Nethermind's own repository, and published
cryptography papers. Below are the exact commands. Tier A needs no clone — just
the Stellar CLI and `curl`.

---

## Tier A — the public blockchain confirms it (no clone, ~2 min)

You need the Stellar CLI and a testnet identity (read-only invokes simulate; the
account only needs to exist):

```bash
# install: https://developers.stellar.org/docs/tools/cli
stellar keys generate skeptic --network testnet   # friendbot funds it
```

**A1. The post-quantum attestation gated real on-chain state.** The gate contract
stores a root as compliance-admitted only after a valid PQ proof verified. Query
it fresh — the state lives on the chain, not in our database:

```bash
stellar contract invoke --id CCFYA7GQ5FRSWA4OXQK52AKQHGZW5GQCDCCOE6VLGDT7DGHNMLTNEOVW \
  --source-account skeptic --network testnet -- \
  is_attested --root_key c618a79b90d2607afd0a8012a6e26cd05476925bae1fd6ccdc6c8677168f1599
# => true

# a root that was never admitted:
stellar contract invoke --id CCFYA7GQ5FRSWA4OXQK52AKQHGZW5GQCDCCOE6VLGDT7DGHNMLTNEOVW \
  --source-account skeptic --network testnet -- \
  is_attested --root_key 0000000000000000000000000000000000000000000000000000000000000000
# => false
```

**A2. The transactions exist in closed ledgers** (confirmed by Horizon, a public
node, not us):

```bash
curl -s https://horizon-testnet.stellar.org/transactions/a2c3227c0bc372c0a69065fc29fdb6c50d4732fec664f34df42c29d71b3142b8 \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('ledger',d['ledger'],'success',d['successful'],'fee',d['fee_charged'])"
# => ledger 3984591 success True fee 404848
```

Or click them in a block explorer:
- gate `admit_root` (valid PQ proof): [`a2c3227c…`](https://stellar.expert/explorer/testnet/tx/a2c3227c0bc372c0a69065fc29fdb6c50d4732fec664f34df42c29d71b3142b8)
- pool `spend` (against the attested root): [`255db58d…`](https://stellar.expert/explorer/testnet/tx/255db58d1d3879f615b4e847c86cfb98a070962801acfee7338de11c57019413)

**A3. The decisive one — the root we attested IS the real ASP root.** Ask the
deployed `asp-membership` contract for its current root (its own source of truth):

```bash
stellar contract invoke --id CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR \
  --source-account skeptic --network testnet -- get_root
# => "4310839444774630776509186067998916458752727384918121419012860917229327270300"
```

That is bit-for-bit our last attested root (index 14). We did not invent it — it
is the live state of a real contract, which you just read yourself.

---

## Tier B — clone and run the code (~5 min)

```bash
git clone https://github.com/Galmanus/spp-compliance-layer
cd spp-compliance-layer && npm install
```

**B1. The tests pass — 31 JavaScript + 16 Rust (8 attestation + 3 guarded-pool + 5 onchain-verifier):**

```bash
npm test                                   # 31 pass, 0 fail
cd attestation && cargo test --release     # append-only-history STARK + parsers
cd ../guarded-pool && cargo test --release # cross-contract gating + replay
```

**B2. The official Stellar codec decodes what our bootnode serves** (drop-in, not
asserted — `@stellar/stellar-base` is the codec every Stellar wallet uses):

```bash
node examples/wallet-syncs-from-bootnode.mjs
# => 15 LeafAdded events, decoded by the canonical SDK, roots 0..14
```

**B3. The whole pipeline, one command, on real data:**

```bash
bash demo.sh
# retention clock -> 15 real leaves -> SDK sync -> attest -> VALID -> tampered INVALID -> on-chain links
```

**B4. Measure the on-chain verification cost yourself** (real metered wasm, not an
estimate):

```bash
cd onchain-verifier && cargo test --release --test measure -- --nocapture
# prints the CPU table: 40 queries = 260M instructions = 65% of one tx
```

---

## Tier C — try to break it (the honesty checks)

We would rather you find the limits than a judge. These confirm the limitations
we state up front are exactly true.

**C1. A fabricated history verifies** — because the attestation proves the
append-only *index structure* over *witnessed* roots, not the roots' legitimacy
(see [`docs/LAYER3-DESIGN.md`](docs/LAYER3-DESIGN.md)):

```bash
echo '[{"index":0,"root":"111"},{"index":1,"root":"222"},{"index":2,"root":"333"}]' > /tmp/fab.json
attestation/target/release/attest-asp-history /tmp/fab.json /tmp/fabo 40
# then verify with the printed limbs — it prints VALID. This is the documented
# scope, pinned by the test `witnessed_roots_a_fabricated_sequence_also_verifies`.
```

**C2. A weak proof cannot admit a root on-chain** — `admit_root` enforces a
40-query floor; submit an 8-query proof and the transaction traps
(`num_queries below the on-chain security floor`).

**C3. Grep for mocks:** there are none in `lib/`, `bin/`, or the contracts —
```bash
grep -rniE "mock|fake|stub|simulat|hardcod" lib bin onchain-verifier/src guarded-pool/src
# only honest disclaimer comments, no mocked behavior.
```

---

## The external references (read the sources, not our summary)

- **Nethermind SPP** — the client hands off to a `bootnode_url`
  (`sdk/client/src/sync.rs`), and the bootnode's own docs name the trust risks we
  close (`docs/src/bootnode.md`): <https://github.com/NethermindEth/stellar-private-payments>
- **Stellar QPP** — "no drop-in post-quantum replacement for pairing-based
  SNARKs": <https://stellar.org/blog/foundation-news/introducing-the-quantum-preparedness-plan>
- **Privacy Pools** (Buterin, Illum, Nadler, Schär, Soleimani, 2023) — the ASP
  mechanism: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4563364>
- **Circle STARKs** (Haböck, Levit, Papini): <https://eprint.iacr.org/2024/278>
- **Reed–Solomon proximity-gap developments (2025)**, which our security note
  cites: <https://eprint.iacr.org/2025/2046>

Nothing above depends on trusting us. Click, clone, and run.

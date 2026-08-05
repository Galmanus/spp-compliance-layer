#!/usr/bin/env bash
# Terminal demo for the README recording. Fast, real, no mocks.
# No `set -e`: the tampered-proof verify exits non-zero by design (INVALID), and
# that must not abort the demo before the on-chain receipts.
set -uo pipefail
cd "$(dirname "$0")/.."

ASP=CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR
ATTEST=attestation/target/release/attest-asp-history
VERIFY=attestation/target/release/verify-asp-history

B=$'\033[1;36m'; G=$'\033[1;32m'; R=$'\033[1;31m'; D=$'\033[2m'; N=$'\033[0m'
say() { printf '\n%s▸ %s%s\n' "$B" "$*" "$N"; sleep 0.6; }
run() { printf '%s$ %s%s\n' "$D" "$*" "$N"; sleep 0.4; eval "$*"; sleep 0.5; }

printf '%s' "$B"
cat <<'BANNER'
  spp-compliance-layer  ·  a verifiable bootnode for Stellar Private Payments
  the memory the RPC deletes, and the proof the pairing cannot outlive
BANNER
printf '%s' "$N"; sleep 0.8

say "the RPC forgets in ~7 days — measured, not assumed"
run "node bin/spp-index.mjs retention | head -3"

say "the index kept 15 real ASP leaves the chain emitted (indices 0..14)"
run "node bin/spp-index.mjs attest $ASP 2>/dev/null | grep -E 'attesting|bytes|indices'"

say "prove it, then let a regulator verify it — a post-quantum STARK, no trusted setup"
node -e "import('./lib/store.mjs').then(m=>{const s=m.openStore();const st=s.aspRootSteps('$ASP');require('fs').writeFileSync('/tmp/d.json',JSON.stringify(st.map(x=>({index:x.index,root:x.root}))));s.close()})"
PV=$($ATTEST /tmp/d.json /tmp/dout | tail -1)
SI=$(echo "$PV" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.start_index,j.first_root_limbs,j.last_root_limbs,j.events)})")
read A F L E <<< "$SI"
run "$VERIFY /tmp/dout/attestation.postcard $A $F $L $E | fold -s -w 78"

say "flip one bit of the attested root — the proof refuses"
run "$VERIFY /tmp/dout/attestation.postcard $A $F ${L%?}1 $E | fold -s -w 78"

say "and it is not just checkable off-chain — it is verified ON-CHAIN, and gates state"
printf '%s' "$G"
cat <<'CHAIN'
  Stellar testnet receipts:
    gate  CA2ZTJXJAXA42M5HYD7YVQNYLCYS2FVQSSQ2MMERC5ODHSK6D7OWZMUY
      admit_root (valid proof)   -> tx 86933844...  root admitted, event emitted
    pool  CAHZAPQPG77ZNX55XUBIWK3ZSEGH4XKCYF5KXUP4GTONPRTQ54LB47PE
      spend (attested root)      -> tx 4a2a83ed...  allowed
      spend (un-admitted root)   -> refused on-chain
CHAIN
printf '%s' "$N"; sleep 1.2

say "no attestation, no admitted root; no admitted root, no spend. all on Stellar."
sleep 1.0

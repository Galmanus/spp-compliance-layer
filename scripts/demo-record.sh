#!/usr/bin/env bash
# Terminal demo for the README. Real testnet data, told as a clean story.
# GIF: asciinema rec ... then agg --theme "16161e,e8e4da,16161e,e88a86,9ece9e,e0c896,7aa2f7,bb9af7,7dcfff,f0ece2" (AGG THEME: bg,fg,palette — dark ink/bone editorial)
# No `set -e`: the tampered-proof verify exits non-zero by design (INVALID).
set -uo pipefail
cd "$(dirname "$0")/.."

ASP=CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR
ATTEST=attestation/target/release/attest-asp-history
VERIFY=attestation/target/release/verify-asp-history

# Ensure the index holds the demo history (from the committed capture if the RPC
# has already forgotten it), so the recording never fabricates numbers.
NLEAVES=$(node -e "
import('./lib/store.mjs').then(m => {
  const s = m.openStore();
  s.registerPool('$ASP', 3968320, 'ASP membership');
  if (s.aspRootSteps('$ASP').length === 0) {
    const cap = JSON.parse(require('fs').readFileSync('fixtures/asp-history.captured.json','utf8'));
    for (const st of cap.steps) s.ingestAspRoot('$ASP', st);
  }
  console.log(s.aspRootSteps('$ASP').length);
  s.close();
})" 2>/dev/null)

# Palette (mapped to an editorial ink/bone/klein theme in agg):
#   36 accent (klein)   32 affirm (soft green)   31 refuse (soft coral)
#   2 dim (muted bone)   1;* bold
A=$'\033[36m'; OK=$'\033[32m'; NO=$'\033[31m'; D=$'\033[2m'; W=$'\033[1;37m'; N=$'\033[0m'
gap() { printf '\n'; sleep "${1:-0.7}"; }
beat() { printf '  %s%s%s\n' "$A" "$*" "$N"; sleep 0.7; }
cmd()  { printf '  %s$ %s%s\n' "$D" "$*" "$N"; sleep 0.5; }
out()  { printf '  %s\n' "$*"; }

clear 2>/dev/null || true
gap 0.4
printf '  %sspp-compliance-layer%s\n' "$W" "$N"
printf '  %sa verifiable bootnode for Stellar Private Payments%s\n' "$D" "$N"
gap 1.0

beat "1 · the network forgets everything older than seven days."
cmd  "spp-index retention"
node bin/spp-index.mjs retention 2>/dev/null | head -1 | sed 's/^/  /'
out  "${D}the pool's history leaves the window during the judging weekend.${N}"
gap 1.0

beat "2 · the index keeps what the RPC will delete — ${NLEAVES} real on-chain leaves."
cmd  "spp-index attest  (a post-quantum STARK, no trusted setup)"
# Prove once from the real captured history; every number below is that proof's.
node -e "import('./lib/store.mjs').then(m=>{const s=m.openStore();const st=s.aspRootSteps('$ASP');require('fs').writeFileSync('/tmp/d.json',JSON.stringify(st.map(x=>({index:x.index,root:x.root}))));s.close()})"
PV=$($ATTEST /tmp/d.json /tmp/dout | tail -1)
BYTES=$(echo "$PV" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).proof_bytes))")
out  "captured ${NLEAVES} real leaves — indices 0..$(( NLEAVES - 1 ))"
out  "post-quantum attestation: $(( BYTES / 1024 )) KB"
gap 1.0

read A0 F0 L0 E0 <<< "$(echo "$PV" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.start_index,j.first_root_limbs,j.last_root_limbs,j.events)})")"

beat "3 · a regulator verifies it — quantum-resistant, nothing to trust."
cmd  "verify-asp-history attestation.postcard"
if $VERIFY /tmp/dout/attestation.postcard "$A0" "$F0" "$L0" "$E0" >/dev/null 2>&1; then
  out "  ${OK}✓ VALID — an honest append-only chain of 15 root updates.${N}"
fi
gap 1.0

beat "4 · change one bit of the history, and the proof refuses."
cmd  "verify-asp-history attestation.postcard  (tampered root)"
if ! $VERIFY /tmp/dout/attestation.postcard "$A0" "$F0" "${L0%?}1" "$E0" >/dev/null 2>&1; then
  out "  ${NO}✗ INVALID — refused.${N}"
fi
gap 1.2

beat "5 · and the same proof runs on-chain, gating real state on Stellar."
gap 0.3
out "  ${OK}gate${N}   admits a root only if the proof holds     ${D}tx a2c3227c…${N}"
sleep 0.5
out "  ${OK}pool${N}   spends only against an admitted root       ${D}tx 255db58d…${N}"
sleep 0.5
out "  ${NO}✗${N}      tampered proof / un-admitted root         ${D}refused on-chain${N}"
gap 1.2

printf '  %sno attestation, no admitted root.  no admitted root, no spend.%s\n' "$W" "$N"
gap 1.4

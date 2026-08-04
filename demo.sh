#!/usr/bin/env bash
# The whole submission, end to end, on real testnet data, in one script.
#
# It audits, captures, attests, and verifies — then tampers and watches the
# verification refuse. Every step is real: a deployed ASP, real LeafAdded
# events, a real Circle-STARK. Nothing is mocked.
#
#   ASP_ID   the ASP membership contract to run against
#            (defaults to the one this submission deployed and populated)
set -euo pipefail
ASP="${ASP_ID:-CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR}"
DB="${NOTEWATCH_DB:-/tmp/spp-demo.db}"
ATTEST="attestation/target/release/attest-asp-history"
VERIFY="attestation/target/release/verify-asp-history"
export NOTEWATCH_DB="$DB"
rm -f "$DB" "$DB"-* 2>/dev/null || true

hr() { printf '\n\033[1m── %s\033[0m\n' "$*"; }

hr "0. the retention clock — the RPC describing its own 7-day amnesia"
node bin/spp-index.mjs retention | head -3

hr "1. register the ASP and capture its real on-chain history"
node bin/spp-index.mjs init >/dev/null
node -e "
import('./lib/store.mjs').then(async m => {
  const s = m.openStore(process.env.NOTEWATCH_DB);
  s.registerPool('$ASP', 3968320, 'ASP membership (real leaves)'); s.close();
  const st = m.openStore(process.env.NOTEWATCH_DB);
  const r = await (await import('./lib/ingest.mjs')).ingestPool(st, '$ASP', { fromLedger: 3968320 });
  console.log('  captured ' + r.aspRoots + ' real LeafAdded events, ' + r.rowsWritten + ' rows written');
  st.close();
});"

hr "2. attest the captured history — post-quantum, no trusted setup"
OUT=$(ATTEST_BIN="$ATTEST" node bin/spp-index.mjs attest "$ASP" | tee /dev/stderr)
# pull the public values back out by re-proving to a known dir
node -e "
import('./lib/store.mjs').then(async m => {
  const s = m.openStore(process.env.NOTEWATCH_DB);
  const steps = s.aspRootSteps('$ASP');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/demo-steps.json', JSON.stringify(steps.map(x=>({index:x.index, root:x.root}))));
  const out = execFileSync('$ATTEST', ['/tmp/demo-steps.json','/tmp/demo-att']).toString();
  const d = JSON.parse(out.trim());
  writeFileSync('/tmp/demo-pub.json', JSON.stringify(d));
  s.close();
});"
FR=$(node -e "console.log(require('/tmp/demo-pub.json').first_root_limbs)")
LR=$(node -e "console.log(require('/tmp/demo-pub.json').last_root_limbs)")
N=$(node -e "console.log(require('/tmp/demo-pub.json').events)")

hr "3. a regulator verifies the attestation — correct roots"
"$VERIFY" /tmp/demo-att/attestation.postcard 0 "$FR" "$LR" "$N" | head -1

hr "4. the same attestation against a TAMPERED final root"
BADLR=$(echo "$LR" | sed 's/^........./deadbeef0/')
set +e
"$VERIFY" /tmp/demo-att/attestation.postcard 0 "$FR" "$BADLR" "$N" | head -1
set -e

hr "done"
echo "Real ASP, real history the RPC will delete, proven honest and post-quantum."
echo "Every step reproducible from contract $ASP."

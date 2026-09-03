#!/bin/bash
S="${S:-$(mktemp -d)}"
SM=$HOME/projects/vineland/vineland/apps/site/public/samples
NET="--network testnet --source admin"; ADMIN=$(stellar keys address admin)
ASP=CBCNAXUHC45Q57AQNSXZCKADYOMOYXMBYTTVFTJ4GLDSNMVNDD3V53I2
VERIFIER=CCXAP4MZUUX5UHBL5MGYMLCHSMRVA3RA4JOCYM7G34LRTTHR67ACYOUC
ROOT=9499b4ccee73c1ebe599e02634bea4ff921adc8d6bb1ca2756a7d2c4dbf5a70e
W=$HOME/spp-compliance-layer/asp-admitter/target/wasm32v1-none/release/vineland_spp_asp_admitter.wasm
step(){ echo; echo "### $1"; }
step "0 ASP root before"; stellar contract invoke --id $ASP $NET -- get_root 2>&1 | tail -1
step "1 deploy admitter"; ADM=$(stellar contract deploy --wasm $W $NET 2>&1 | tail -1); echo "ADM=$ADM"
step "2 init admitter (asp=$ASP, verifier, root=keccak(sample), nq12 lb7)"; stellar contract invoke --id $ADM $NET --send=yes -- init --admin $ADMIN --asp $ASP --verifier $VERIFIER --root $ROOT --nq 12 --lb 7 2>&1 | tail -1
step "3 hand the ASP admin to the admitter (asp.update_admin, signed by current admin key)"; stellar contract invoke --id $ASP $NET --send=yes -- update_admin --new_admin $ADM 2>&1 | tail -1
step "4 old admin key tries insert_leaf directly (expect auth failure)"; stellar contract invoke --id $ASP $NET --send=yes -- insert_leaf --leaf 99 2>&1 | grep -oiE 'Error\([^)]*\)|not authorized|auth[a-z ]*fail[a-z]*|Unauthorized' | head -1
step "5 admit pool key 123456789 with the 82KB STARK proof (no caller auth; proof is the credential)"; stellar contract invoke --id $ADM $NET --send=yes -- admit --leaf 123456789 --mem_proof-file-path $SM/crowd_membership.postcard --mem_publics-file-path $SM/crowd_membership_publics.le64 2>&1 | grep -E 'Event|Success|error' | head -3
step "5b ASP root after"; stellar contract invoke --id $ASP $NET -- get_root 2>&1 | tail -1
step "6 replay the same proof for another key (expect CommitmentUsed #6)"; stellar contract invoke --id $ADM $NET --send=yes -- admit --leaf 5 --mem_proof-file-path $SM/crowd_membership.postcard --mem_publics-file-path $SM/crowd_membership_publics.le64 2>&1 | grep -oE 'Error\(Contract, #[0-9]+\)' | head -1
step "7 tampered proof (expect MembershipRejected #5)"; cp $SM/crowd_membership.postcard $S/tampered.postcard; printf '\xff' | dd of=$S/tampered.postcard bs=1 seek=4000 conv=notrunc 2>/dev/null; cp $SM/crowd_membership_publics.le64 $S/pub2.le64; printf '\x11' | dd of=$S/pub2.le64 bs=1 seek=0 conv=notrunc 2>/dev/null; stellar contract invoke --id $ADM $NET --send=yes -- admit --leaf 6 --mem_proof-file-path $S/tampered.postcard --mem_publics-file-path $S/pub2.le64 2>&1 | grep -oE 'Error\(Contract, #[0-9]+\)' | head -1
step "8 leaf >= r (expect LeafOutOfField #7)"; stellar contract invoke --id $ADM $NET --send=yes -- admit --leaf 21888242871839275222246405745257275088548364400416034343698204186575808495617 --mem_proof-file-path $S/tampered.postcard --mem_publics-file-path $S/pub2.le64 2>&1 | grep -oE 'Error\(Contract, #[0-9]+\)' | head -1
step "9 tx hashes (admin, newest first)"; curl -s "https://horizon-testnet.stellar.org/accounts/$ADMIN/transactions?order=desc&limit=5" | python3 -c "
import sys,json
for r in json.load(sys.stdin)['_embedded']['records']: print(r['hash'], r['successful'], r['created_at'])"
echo "ADM=$ADM ASP=$ASP" | tee $S/e2e_asp_ids.txt

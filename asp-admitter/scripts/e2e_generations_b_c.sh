#!/bin/bash
S=/tmp/claude-1000/-home-galmanus/79a61f4b-5f36-4e29-b31e-61ca6bf5505f/scratchpad
SM=$HOME/projects/vineland/vineland/apps/site/public/samples
NET="--network testnet --source admin"; ADMIN=$(stellar keys address admin)
ASP=CBCNAXUHC45Q57AQNSXZCKADYOMOYXMBYTTVFTJ4GLDSNMVNDD3V53I2
A=CAA3VHNLGN62B2WG7JVQZ43WF2SZBFFUI3LEMLGV36Y6YXXQG2A4EPH4
VERIFIER=CCXAP4MZUUX5UHBL5MGYMLCHSMRVA3RA4JOCYM7G34LRTTHR67ACYOUC
ROOT=9499b4ccee73c1ebe599e02634bea4ff921adc8d6bb1ca2756a7d2c4dbf5a70e
W=$HOME/spp-compliance-layer/asp-admitter/target/wasm32v1-none/release/vineland_spp_asp_admitter.wasm
LEAF=987654321
H=$(python3 -c "
import hashlib
pub=open('$SM/crowd_membership_publics.le64','rb').read()
leaf=($LEAF).to_bytes(32,'big')
print(hashlib.sha256(leaf+pub[0:64]).hexdigest())")
step(){ echo; echo "### $1"; }
step "1 deploy generation B (predecessor = A)"; B=$(stellar contract deploy --wasm $W $NET -- --admin $ADMIN --asp $ASP --verifier $VERIFIER --root $ROOT --nq 12 --lb 7 --predecessor "\"$A\"" 2>&1 | tail -1); echo "B=$B"
step "2 A hands the ASP admin to B (signed by issuer admin)"; stellar contract invoke --id $A $NET --send=yes -- hand_back_asp_admin --new_admin $B 2>&1 | tail -1
step "3 B locks the ASP (admin-only insert re-asserted)"; stellar contract invoke --id $B $NET --send=yes -- lock_asp 2>&1 | tail -1
step "4 B: commit(sha256(leaf||C)) for the historical proof's C"; stellar contract invoke --id $B $NET --send=yes -- commit --h $H 2>&1 | tail -1; sleep 6
step "5 B: admit with the historical proof (expect CommitmentUsed #6 via predecessor A)"; stellar contract invoke --id $B $NET --send=yes -- admit --leaf $LEAF --mem_proof-file-path $SM/crowd_membership.postcard --mem_publics-file-path $SM/crowd_membership_publics.le64 2>&1 | grep -oE 'Error\(Contract, #[0-9]+\)' | head -1
step "6 deploy generation C (fresh set epoch: no predecessor)"; C=$(stellar contract deploy --wasm $W $NET -- --admin $ADMIN --asp $ASP --verifier $VERIFIER --root $ROOT --nq 12 --lb 7 2>&1 | tail -1); echo "C=$C"
step "7 B hands the ASP admin to C"; stellar contract invoke --id $B $NET --send=yes -- hand_back_asp_admin --new_admin $C 2>&1 | tail -1
step "8 C: admit WITHOUT commit (expect NoCommit #8)"; stellar contract invoke --id $C $NET --send=yes -- admit --leaf $LEAF --mem_proof-file-path $SM/crowd_membership.postcard --mem_publics-file-path $SM/crowd_membership_publics.le64 2>&1 | grep -oE 'Error\(Contract, #[0-9]+\)' | head -1
step "9 C: commit(sha256(leaf||C))"; stellar contract invoke --id $C $NET --send=yes -- commit --h $H 2>&1 | tail -1; sleep 6
step "10 C: substitution attempt: same proof, attacker leaf 111 (expect NoCommit #8)"; stellar contract invoke --id $C $NET --send=yes -- admit --leaf 111 --mem_proof-file-path $SM/crowd_membership.postcard --mem_publics-file-path $SM/crowd_membership_publics.le64 2>&1 | grep -oE 'Error\(Contract, #[0-9]+\)' | head -1
step "11 C: reveal: admit(leaf $LEAF, proof) (expect LeafAdded + KeyAdmitted)"; stellar contract invoke --id $C $NET --send=yes -- admit --leaf $LEAF --mem_proof-file-path $SM/crowd_membership.postcard --mem_publics-file-path $SM/crowd_membership_publics.le64 2>&1 | grep -E 'Event|error' | head -2
step "11b ASP root now"; stellar contract invoke --id $ASP $NET -- get_root 2>&1 | tail -1
step "12 C: replay (expect CommitmentUsed #6)"; stellar contract invoke --id $C $NET --send=yes -- commit --h $H 2>&1 | tail -1; sleep 6; stellar contract invoke --id $C $NET --send=yes -- admit --leaf $LEAF --mem_proof-file-path $SM/crowd_membership.postcard --mem_publics-file-path $SM/crowd_membership_publics.le64 2>&1 | grep -oE 'Error\(Contract, #[0-9]+\)' | head -1
step "13 tx hashes (admin, newest first, 10)"; curl -s "https://horizon-testnet.stellar.org/accounts/$ADMIN/transactions?order=desc&limit=10" | python3 -c "
import sys,json
for r in json.load(sys.stdin)['_embedded']['records']: print(r['hash'], r['successful'], r['created_at'][11:19])"
echo "B=$B C=$C H=$H" | tee $S/e2e_asp2_ids.txt

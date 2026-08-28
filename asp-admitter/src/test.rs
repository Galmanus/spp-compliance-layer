#![cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    testutils::{Address as _, Ledger},
    Address, Bytes, BytesN, Env, U256, Vec,
};

use crate::{commit_hash, Error, VinelandSppAspAdmitter, VinelandSppAspAdmitterClient};

#[contract]
struct MockVerifier;
#[contractimpl]
impl MockVerifier {
    pub fn set(e: Env, ok: bool) {
        e.storage().instance().set(&symbol_short!("ok"), &ok);
    }
    pub fn verify_crowd_membership(e: Env, _p: Bytes, _pubs: Bytes, _nq: u32, _lb: u32) -> bool {
        e.storage().instance().get(&symbol_short!("ok")).unwrap_or(false)
    }
}

// Mock of Nethermind's asp-membership: admin-only insert (admin.require_auth
// when the flag is on), capacity, records leaves, root = leaf count.
#[contracttype]
enum K {
    Admin,
    Leaves,
    AdminOnly,
    Cap,
}
#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
enum AspErr {
    Full = 2,
}
#[contract]
struct MockAsp;
#[contractimpl]
impl MockAsp {
    pub fn __constructor(e: Env, admin: Address, cap: u32) {
        e.storage().persistent().set(&K::Admin, &admin);
        e.storage().persistent().set(&K::Leaves, &Vec::<U256>::new(&e));
        e.storage().persistent().set(&K::AdminOnly, &true);
        e.storage().persistent().set(&K::Cap, &cap);
    }
    pub fn insert_leaf(e: Env, leaf: U256) -> Result<(), AspErr> {
        let admin_only: bool = e.storage().persistent().get(&K::AdminOnly).unwrap();
        if admin_only {
            let admin: Address = e.storage().persistent().get(&K::Admin).unwrap();
            admin.require_auth();
        }
        let mut v: Vec<U256> = e.storage().persistent().get(&K::Leaves).unwrap();
        let cap: u32 = e.storage().persistent().get(&K::Cap).unwrap();
        if v.len() >= cap {
            return Err(AspErr::Full);
        }
        v.push_back(leaf);
        e.storage().persistent().set(&K::Leaves, &v);
        Ok(())
    }
    pub fn update_admin(e: Env, new_admin: Address) {
        let admin: Address = e.storage().persistent().get(&K::Admin).unwrap();
        admin.require_auth();
        e.storage().persistent().set(&K::Admin, &new_admin);
    }
    pub fn set_admin_insert_only(e: Env, admin_only: bool) {
        let admin: Address = e.storage().persistent().get(&K::Admin).unwrap();
        admin.require_auth();
        e.storage().persistent().set(&K::AdminOnly, &admin_only);
    }
    pub fn get_root(e: Env) -> U256 {
        let v: Vec<U256> = e.storage().persistent().get(&K::Leaves).unwrap();
        U256::from_u32(&e, v.len())
    }
    pub fn admin(e: Env) -> Address {
        e.storage().persistent().get(&K::Admin).unwrap()
    }
    pub fn admin_only(e: Env) -> bool {
        e.storage().persistent().get(&K::AdminOnly).unwrap()
    }
    pub fn leaves(e: Env) -> Vec<U256> {
        e.storage().persistent().get(&K::Leaves).unwrap()
    }
}

fn publics(e: &Env, commitment_byte: u8, root_preimage: &[u8; 64]) -> (Bytes, BytesN<32>) {
    let mut v = [commitment_byte; 128];
    v[64..128].copy_from_slice(root_preimage);
    let p = Bytes::from_array(e, &v);
    let root = e.crypto().keccak256(&p.slice(64..128)).into();
    (p, root)
}

struct F {
    e: Env,
    a: VinelandSppAspAdmitterClient<'static>,
    asp: MockAspClient<'static>,
    verifier: MockVerifierClient<'static>,
    admin: Address,
    publics: Bytes,
    proof: Bytes,
}

/// Builds the stack with the ADMITTER as the ASP admin. No `mock_all_auths`:
/// contract-to-contract auth must hold on its own, which is what we test.
fn setup_with(admitter_is_asp_admin: bool, cap: u32) -> F {
    let e = Env::default();
    let admin = Address::generate(&e);
    let verifier_id = e.register(MockVerifier, ());
    let verifier = MockVerifierClient::new(&e, &verifier_id);
    verifier.set(&true);
    let (publics, root) = publics(&e, 3, &[9u8; 64]);
    // Two-phase because the ASP needs the admitter's address and vice versa:
    // deploy the admitter pointing at a placeholder, then the ASP, then re-point.
    let asp_placeholder = Address::generate(&e);
    let a_id = e.register(
        VinelandSppAspAdmitter,
        (&admin, &asp_placeholder, &verifier_id, &root, &12u32, &7u32, &None::<Address>),
    );
    let asp_admin = if admitter_is_asp_admin { a_id.clone() } else { Address::generate(&e) };
    let asp_id = e.register(MockAsp, (&asp_admin, &cap));
    // re-register the admitter with the real ASP address (fresh instance)
    let a_id = e.register(
        VinelandSppAspAdmitter,
        (&admin, &asp_id, &verifier_id, &root, &12u32, &7u32, &None::<Address>),
    );
    if admitter_is_asp_admin {
        e.mock_all_auths();
        MockAspClient::new(&e, &asp_id).update_admin(&a_id);
        e.set_auths(&[]);
    }
    let a = VinelandSppAspAdmitterClient::new(&e, &a_id);
    let asp = MockAspClient::new(&e, &asp_id);
    let proof = Bytes::from_array(&e, &[1u8; 32]);
    F { e, a, asp, verifier, admin, publics, proof }
}
fn setup(admitter_is_asp_admin: bool) -> F {
    setup_with(admitter_is_asp_admin, 100)
}

fn next_ledger(e: &Env) {
    e.ledger().with_mut(|l| l.sequence_number += 1);
}

/// commit(sha256(leaf || C)) in this ledger, then move to the next one.
fn commit_for(f: &F, leaf: &U256, publics: &Bytes) {
    let h = commit_hash(&f.e, leaf, &publics.slice(0..64));
    f.a.commit(&h);
    next_ledger(&f.e);
}

#[test]
fn commit_then_admit_inserts_the_leaf_into_the_asp() {
    let f = setup(true);
    let leaf = U256::from_u32(&f.e, 4242);
    commit_for(&f, &leaf, &f.publics);
    f.a.admit(&leaf, &f.proof, &f.publics);
    assert_eq!(f.asp.leaves().len(), 1);
    assert_eq!(f.asp.leaves().get(0).unwrap(), leaf);
    assert!(f.a.is_used(&f.publics.slice(0..64)));
}

#[test]
fn admit_without_a_commit_is_refused() {
    let f = setup(true);
    let r = f.a.try_admit(&U256::from_u32(&f.e, 1), &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::NoCommit)));
}

#[test]
fn commit_and_reveal_in_the_same_ledger_is_refused() {
    let f = setup(true);
    let leaf = U256::from_u32(&f.e, 1);
    f.a.commit(&commit_hash(&f.e, &leaf, &f.publics.slice(0..64)));
    let r = f.a.try_admit(&leaf, &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::CommitTooFresh)));
    next_ledger(&f.e);
    f.a.admit(&leaf, &f.proof, &f.publics);
}

#[test]
fn a_third_party_cannot_substitute_its_own_leaf_for_a_seen_proof() {
    // Honest member committed (leaf_h, C). Attacker sees the reveal tx (proof +
    // publics) and tries the same proof with its own leaf: no commit for
    // (leaf_a, C) exists, so it is refused, and the honest reveal still works.
    let f = setup(true);
    let honest = U256::from_u32(&f.e, 1000);
    commit_for(&f, &honest, &f.publics);
    let attacker = U256::from_u32(&f.e, 6666);
    let r = f.a.try_admit(&attacker, &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::NoCommit)));
    // attacker now commits (leaf_a, C) after seeing C, but the honest member
    // reveals first (their commit is older); C is then used.
    f.a.commit(&commit_hash(&f.e, &attacker, &f.publics.slice(0..64)));
    next_ledger(&f.e);
    f.a.admit(&honest, &f.proof, &f.publics);
    let r = f.a.try_admit(&attacker, &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::CommitmentUsed)));
    assert_eq!(f.asp.leaves().len(), 1);
    assert_eq!(f.asp.leaves().get(0).unwrap(), honest);
}

#[test]
fn a_rejected_proof_inserts_nothing_and_keeps_the_commit() {
    let f = setup(true);
    let leaf = U256::from_u32(&f.e, 1);
    commit_for(&f, &leaf, &f.publics);
    f.verifier.set(&false);
    let r = f.a.try_admit(&leaf, &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::MembershipRejected)));
    assert_eq!(f.asp.leaves().len(), 0);
    assert!(!f.a.is_used(&f.publics.slice(0..64)));
    f.verifier.set(&true);
    f.a.admit(&leaf, &f.proof, &f.publics); // commit still valid
}

#[test]
fn a_proof_for_another_issuers_set_is_refused() {
    let f = setup(true);
    let (other, _) = publics(&f.e, 3, &[8u8; 64]);
    let leaf = U256::from_u32(&f.e, 1);
    commit_for(&f, &leaf, &other);
    let r = f.a.try_admit(&leaf, &f.proof, &other);
    assert_eq!(r, Err(Ok(Error::RootMismatch)));
}

#[test]
fn the_same_member_commitment_cannot_admit_a_second_leaf() {
    let f = setup(true);
    let l1 = U256::from_u32(&f.e, 1);
    let l2 = U256::from_u32(&f.e, 2);
    commit_for(&f, &l1, &f.publics);
    commit_for(&f, &l2, &f.publics);
    f.a.admit(&l1, &f.proof, &f.publics);
    let r = f.a.try_admit(&l2, &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::CommitmentUsed)));
    assert_eq!(f.asp.leaves().len(), 1);
}

#[test]
fn a_different_member_admits_its_own_leaf() {
    let f = setup(true);
    let l1 = U256::from_u32(&f.e, 1);
    commit_for(&f, &l1, &f.publics);
    f.a.admit(&l1, &f.proof, &f.publics);
    let (p2, _) = publics(&f.e, 5, &[9u8; 64]);
    let l2 = U256::from_u32(&f.e, 2);
    commit_for(&f, &l2, &p2);
    f.a.admit(&l2, &f.proof, &p2);
    assert_eq!(f.asp.leaves().len(), 2);
}

#[test]
fn malformed_publics_are_refused() {
    let f = setup(true);
    let short = Bytes::from_array(&f.e, &[0u8; 100]);
    let r = f.a.try_admit(&U256::from_u32(&f.e, 1), &f.proof, &short);
    assert_eq!(r, Err(Ok(Error::BadPublics)));
}

#[test]
fn a_leaf_outside_the_bn254_scalar_field_is_refused() {
    let f = setup(true);
    let r = U256::from_be_bytes(&f.e, &Bytes::from_array(&f.e, &crate::BN254_R));
    let r_minus_1 = r.sub(&U256::from_u32(&f.e, 1));
    assert_eq!(f.a.try_admit(&r, &f.proof, &f.publics), Err(Ok(Error::LeafOutOfField)));
    commit_for(&f, &r_minus_1, &f.publics);
    f.a.admit(&r_minus_1, &f.proof, &f.publics);
    assert_eq!(f.asp.leaves().len(), 1);
}

#[test]
fn when_the_admitter_is_not_the_asp_admin_the_insert_fails_cleanly() {
    let f = setup(false);
    let leaf = U256::from_u32(&f.e, 1);
    commit_for(&f, &leaf, &f.publics);
    let r = f.a.try_admit(&leaf, &f.proof, &f.publics);
    assert!(r.is_err());
    assert_eq!(f.asp.leaves().len(), 0);
}

#[test]
fn a_full_asp_is_reported_as_asp_rejected_and_nothing_is_consumed() {
    let f = setup_with(true, 1);
    let l1 = U256::from_u32(&f.e, 1);
    let (p2, _) = publics(&f.e, 5, &[9u8; 64]);
    let l2 = U256::from_u32(&f.e, 2);
    commit_for(&f, &l1, &f.publics);
    commit_for(&f, &l2, &p2);
    f.a.admit(&l1, &f.proof, &f.publics);
    let r = f.a.try_admit(&l2, &f.proof, &p2);
    assert_eq!(r, Err(Ok(Error::AspRejected)));
    assert!(!f.a.is_used(&p2.slice(0..64)));
}

#[test]
fn a_successor_generation_honours_the_predecessors_used_set() {
    let f = setup(true);
    let l1 = U256::from_u32(&f.e, 1);
    commit_for(&f, &l1, &f.publics);
    f.a.admit(&l1, &f.proof, &f.publics);
    // new admitter generation naming the old one as predecessor
    let (_, root) = publics(&f.e, 3, &[9u8; 64]);
    let a2_id = f.e.register(
        VinelandSppAspAdmitter,
        (&f.admin, &f.asp.address, &f.verifier.address, &root, &12u32, &7u32, &Some(f.a.address.clone())),
    );
    f.e.mock_all_auths();
    f.a.hand_back_asp_admin(&a2_id);
    f.e.set_auths(&[]);
    let a2 = VinelandSppAspAdmitterClient::new(&f.e, &a2_id);
    let l2 = U256::from_u32(&f.e, 2);
    a2.commit(&commit_hash(&f.e, &l2, &f.publics.slice(0..64)));
    next_ledger(&f.e);
    let r = a2.try_admit(&l2, &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::CommitmentUsed)));
    assert_eq!(f.asp.leaves().len(), 1);
}

#[test]
fn lock_asp_reasserts_admin_only_insertion() {
    let f = setup(true);
    // someone with the ASP admin (the admitter) never opened it, but simulate
    // an opened tree and re-lock through the admitter
    f.e.mock_all_auths();
    f.asp.set_admin_insert_only(&false);
    assert!(!f.asp.admin_only());
    f.a.lock_asp();
    assert!(f.asp.admin_only());
}

#[test]
fn set_root_rotates_the_issuer_set_and_used_marks_survive() {
    let f = setup(true);
    let l1 = U256::from_u32(&f.e, 1);
    commit_for(&f, &l1, &f.publics);
    f.a.admit(&l1, &f.proof, &f.publics);
    let (p_new, root_new) = publics(&f.e, 3, &[8u8; 64]); // same member C, new set
    f.e.mock_all_auths();
    f.a.set_root(&root_new);
    f.e.set_auths(&[]);
    let l2 = U256::from_u32(&f.e, 2);
    commit_for(&f, &l2, &p_new);
    let r = f.a.try_admit(&l2, &f.proof, &p_new);
    assert_eq!(r, Err(Ok(Error::CommitmentUsed)));
    let (p_other, _) = publics(&f.e, 4, &[8u8; 64]);
    commit_for(&f, &l2, &p_other);
    f.a.admit(&l2, &f.proof, &p_other);
    assert_eq!(f.asp.leaves().len(), 2);
}

#[test]
fn the_issuer_can_hand_the_asp_back_and_the_admitter_then_cannot_insert() {
    let f = setup(true);
    let issuer = f.admin.clone();
    f.e.mock_all_auths();
    f.a.hand_back_asp_admin(&issuer);
    assert_eq!(f.asp.admin(), issuer);
    f.e.set_auths(&[]);
    let leaf = U256::from_u32(&f.e, 1);
    commit_for(&f, &leaf, &f.publics);
    let r = f.a.try_admit(&leaf, &f.proof, &f.publics);
    assert!(r.is_err());
    assert_eq!(f.asp.leaves().len(), 0);
}

#[test]
#[should_panic]
fn admin_operations_require_the_issuer_admin() {
    let f = setup(true);
    let mallory = Address::generate(&f.e);
    f.a.hand_back_asp_admin(&mallory); // no auth mocked
}

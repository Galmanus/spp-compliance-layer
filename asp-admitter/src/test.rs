#![cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, testutils::Address as _, Address,
    Bytes, BytesN, Env, U256, Vec,
};

use crate::{Error, VinelandSppAspAdmitter, VinelandSppAspAdmitterClient};

// Mock STARK verifier: accept/reject by flag.
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

// Mock of Nethermind's asp-membership: admin-only insert (admin.require_auth),
// records leaves, root = leaf count (enough to observe insertion).
#[contracttype]
enum K {
    Admin,
    Leaves,
}
#[contract]
struct MockAsp;
#[contractimpl]
impl MockAsp {
    pub fn __constructor(e: Env, admin: Address) {
        e.storage().persistent().set(&K::Admin, &admin);
        e.storage().persistent().set(&K::Leaves, &Vec::<U256>::new(&e));
    }
    pub fn insert_leaf(e: Env, leaf: U256) {
        let admin: Address = e.storage().persistent().get(&K::Admin).unwrap();
        admin.require_auth();
        let mut v: Vec<U256> = e.storage().persistent().get(&K::Leaves).unwrap();
        v.push_back(leaf);
        e.storage().persistent().set(&K::Leaves, &v);
    }
    pub fn update_admin(e: Env, new_admin: Address) {
        let admin: Address = e.storage().persistent().get(&K::Admin).unwrap();
        admin.require_auth();
        e.storage().persistent().set(&K::Admin, &new_admin);
    }
    pub fn get_root(e: Env) -> U256 {
        let v: Vec<U256> = e.storage().persistent().get(&K::Leaves).unwrap();
        U256::from_u32(&e, v.len())
    }
    pub fn admin(e: Env) -> Address {
        e.storage().persistent().get(&K::Admin).unwrap()
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
fn setup(admitter_is_asp_admin: bool) -> F {
    let e = Env::default();
    let admin = Address::generate(&e);
    let verifier_id = e.register(MockVerifier, ());
    let verifier = MockVerifierClient::new(&e, &verifier_id);
    verifier.set(&true);
    let (publics, root) = publics(&e, 3, &[9u8; 64]);
    let a_id = e.register(VinelandSppAspAdmitter, ());
    let a = VinelandSppAspAdmitterClient::new(&e, &a_id);
    let asp_admin = if admitter_is_asp_admin { a_id.clone() } else { Address::generate(&e) };
    let asp_id = e.register(MockAsp, (&asp_admin,));
    let asp = MockAspClient::new(&e, &asp_id);
    e.mock_all_auths(); // only for init's admin.require_auth
    a.init(&admin, &asp_id, &verifier_id, &root, &12, &7);
    e.set_auths(&[]); // from here on: no mocked auths at all
    let proof = Bytes::from_array(&e, &[1u8; 32]);
    F { e, a, asp, verifier, admin, publics, proof }
}

#[test]
fn a_valid_proof_inserts_the_pool_key_into_the_asp() {
    let f = setup(true);
    let key = U256::from_u32(&f.e, 4242);
    f.a.admit(&key, &f.proof, &f.publics);
    assert_eq!(f.asp.leaves().len(), 1);
    assert_eq!(f.asp.leaves().get(0).unwrap(), key);
    assert!(f.a.is_used(&f.publics.slice(0..64)));
}

#[test]
fn a_rejected_proof_inserts_nothing() {
    let f = setup(true);
    f.verifier.set(&false);
    let r = f.a.try_admit(&U256::from_u32(&f.e, 1), &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::MembershipRejected)));
    assert_eq!(f.asp.leaves().len(), 0);
    assert!(!f.a.is_used(&f.publics.slice(0..64)));
}

#[test]
fn a_proof_for_another_issuers_set_is_refused() {
    let f = setup(true);
    let (other, _) = publics(&f.e, 3, &[8u8; 64]);
    let r = f.a.try_admit(&U256::from_u32(&f.e, 1), &f.proof, &other);
    assert_eq!(r, Err(Ok(Error::RootMismatch)));
}

#[test]
fn the_same_member_commitment_cannot_admit_a_second_key() {
    let f = setup(true);
    f.a.admit(&U256::from_u32(&f.e, 1), &f.proof, &f.publics);
    let r = f.a.try_admit(&U256::from_u32(&f.e, 2), &f.proof, &f.publics);
    assert_eq!(r, Err(Ok(Error::CommitmentUsed)));
    assert_eq!(f.asp.leaves().len(), 1);
}

#[test]
fn a_different_member_admits_its_own_key() {
    let f = setup(true);
    f.a.admit(&U256::from_u32(&f.e, 1), &f.proof, &f.publics);
    let (p2, _) = publics(&f.e, 5, &[9u8; 64]); // other commitment, same set
    f.a.admit(&U256::from_u32(&f.e, 2), &f.proof, &p2);
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
#[should_panic]
fn when_the_admitter_is_not_the_asp_admin_the_insert_fails() {
    let f = setup(false);
    f.a.admit(&U256::from_u32(&f.e, 1), &f.proof, &f.publics);
}

#[test]
fn the_issuer_can_hand_the_asp_back_and_the_admitter_then_cannot_insert() {
    let f = setup(true);
    let issuer = f.admin.clone();
    f.e.mock_all_auths();
    f.a.hand_back_asp_admin(&issuer);
    assert_eq!(f.asp.admin(), issuer);
    f.e.set_auths(&[]);
    let r = f.a.try_admit(&U256::from_u32(&f.e, 1), &f.proof, &f.publics);
    assert!(r.is_err());
    assert_eq!(f.asp.leaves().len(), 0);
}

#[test]
#[should_panic]
fn hand_back_requires_the_issuer_admin() {
    let f = setup(true);
    let mallory = Address::generate(&f.e);
    f.a.hand_back_asp_admin(&mallory); // no auth mocked
}

#[test]
fn a_pool_key_outside_the_bn254_scalar_field_is_refused() {
    let f = setup(true);
    // r itself is the smallest out-of-field value; r - 1 is the largest in-field one.
    let r = U256::from_be_bytes(&f.e, &Bytes::from_array(&f.e, &crate::BN254_R));
    let r_minus_1 = r.sub(&U256::from_u32(&f.e, 1));
    assert_eq!(
        f.a.try_admit(&r, &f.proof, &f.publics),
        Err(Ok(Error::LeafOutOfField))
    );
    f.a.admit(&r_minus_1, &f.proof, &f.publics);
    assert_eq!(f.asp.leaves().len(), 1);
}

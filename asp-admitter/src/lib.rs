#![no_std]
//! KYC-gated, unlinkable admission into an SPP Association Set.
//!
//! Stellar Private Payments (Nethermind) enforces compliance through an
//! Association Set Provider: a Merkle tree of approved pool public keys
//! (`asp-membership`) whose root every pool transaction proves against. Who gets
//! into that tree is decided by the tree's admin, off-chain, with the admin
//! learning exactly which real-world identity each pool key belongs to.
//!
//! This contract replaces that step. It becomes the admin of an `asp-membership`
//! instance and inserts a pool key only after a transparent, hash-based STARK
//! proof that the requester belongs to the issuer's KYC'd set. The proof shows
//! *a* member asked, never *which* one, so the ASP admits KYC'd keys without
//! holding a pubkey-to-person mapping. Amount and counterparty privacy stay the
//! pool's job; this only fixes the entry.
//!
//! Each member commitment admits one pool key: a published proof cannot be
//! re-used to admit a second key (this is the partial mitigation of the F16
//! replay finding; full binding needs the pool key inside the proof's publics).
//!
//! Recovery: the issuer admin can hand the ASP back (`hand_back_asp_admin`), so
//! a bug here cannot brick the tree.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec, U256,
};

/// Membership publics layout: `commitment(64) || root(64)` = 128 bytes.
const MEM_PUBLICS_LEN: u32 = 128;
const TTL_THRESHOLD_LEDGERS: u32 = 17_280;
const TTL_TARGET_LEDGERS: u32 = 535_000;

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    /// Nethermind `asp-membership` instance this contract administers.
    pub asp: Address,
    /// crowd membership verifier: `verify_crowd_membership(proof, publics, nq, lb) -> bool`.
    pub verifier: Address,
    /// keccak256 of the issuer set's STARK root.
    pub root: BytesN<32>,
    pub nq: u32,
    pub lb: u32,
}

#[contracttype]
pub enum DataKey {
    Config,
    /// `Used(commitment)`: this member commitment already admitted a key.
    Used(Bytes),
}

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    AlreadyInit = 1,
    NotInit = 2,
    BadPublics = 3,
    /// The proof's root does not match this issuer's set.
    RootMismatch = 4,
    /// The membership verifier rejected the proof.
    MembershipRejected = 5,
    /// This member commitment already admitted a pool key.
    CommitmentUsed = 6,
    /// The pool key is not a BN254 scalar-field element (the pool's Poseidon2
    /// tree and Groth16 circuits only accept `leaf < r`).
    LeafOutOfField = 7,
}

/// BN254 scalar field modulus r (circom / SPP field), big-endian.
pub const BN254_R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn in_field(e: &Env, leaf: &U256) -> bool {
    let r = U256::from_be_bytes(e, &Bytes::from_array(e, &BN254_R));
    *leaf < r
}

#[contractclient(name = "AspClient")]
pub trait AspMembership {
    fn insert_leaf(e: Env, leaf: U256);
    fn update_admin(e: Env, new_admin: Address);
    fn get_root(e: Env) -> U256;
}

#[contractevent]
pub struct KeyAdmitted {
    #[topic]
    pub leaf: U256,
    pub asp_root: U256,
}

fn cfg(e: &Env) -> Result<Config, Error> {
    e.storage().instance().get(&DataKey::Config).ok_or(Error::NotInit)
}

#[contract]
pub struct VinelandSppAspAdmitter;

#[contractimpl]
impl VinelandSppAspAdmitter {
    pub fn init(
        e: Env,
        admin: Address,
        asp: Address,
        verifier: Address,
        root: BytesN<32>,
        nq: u32,
        lb: u32,
    ) -> Result<(), Error> {
        if e.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInit);
        }
        admin.require_auth();
        e.storage()
            .instance()
            .set(&DataKey::Config, &Config { admin, asp, verifier, root, nq, lb });
        e.storage().instance().extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_TARGET_LEDGERS);
        Ok(())
    }

    /// Admit `leaf` (a pool public key) into the ASP by proving the requester is
    /// a member of the issuer's set. No caller auth: the proof is the credential.
    /// One admission per member commitment.
    pub fn admit(e: Env, leaf: U256, mem_proof: Bytes, mem_publics: Bytes) -> Result<(), Error> {
        let c = cfg(&e)?;
        if !in_field(&e, &leaf) {
            return Err(Error::LeafOutOfField);
        }
        if mem_publics.len() != MEM_PUBLICS_LEN {
            return Err(Error::BadPublics);
        }
        let root_digest = mem_publics.slice(64..128);
        if keccak32(&e, &root_digest) != c.root {
            return Err(Error::RootMismatch);
        }
        let commitment = mem_publics.slice(0..64);
        let used_key = DataKey::Used(commitment.clone());
        if e.storage().persistent().has(&used_key) {
            return Err(Error::CommitmentUsed);
        }
        let args: Vec<Val> = (mem_proof, mem_publics, c.nq, c.lb).into_val(&e);
        let ok: bool =
            e.invoke_contract(&c.verifier, &Symbol::new(&e, "verify_crowd_membership"), args);
        if !ok {
            return Err(Error::MembershipRejected);
        }
        // Mark the commitment before the cross-call so a re-entrant path cannot
        // admit twice on the same proof.
        e.storage().persistent().set(&used_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&used_key, TTL_THRESHOLD_LEDGERS, TTL_TARGET_LEDGERS);
        let asp = AspClient::new(&e, &c.asp);
        asp.insert_leaf(&leaf);
        let asp_root = asp.get_root();
        KeyAdmitted { leaf, asp_root }.publish(&e);
        Ok(())
    }

    /// Has this member commitment already admitted a key?
    pub fn is_used(e: Env, commitment: Bytes) -> bool {
        e.storage().persistent().has(&DataKey::Used(commitment))
    }

    /// Issuer admin: hand the ASP's admin role to another address (recovery, or
    /// migration to a new admitter). After this call this contract can no
    /// longer insert.
    pub fn hand_back_asp_admin(e: Env, new_admin: Address) -> Result<(), Error> {
        let c = cfg(&e)?;
        c.admin.require_auth();
        AspClient::new(&e, &c.asp).update_admin(&new_admin);
        Ok(())
    }

    pub fn config(e: Env) -> Result<Config, Error> {
        cfg(&e)
    }
}

fn keccak32(e: &Env, b: &Bytes) -> BytesN<32> {
    e.crypto().keccak256(b).into()
}

mod test;

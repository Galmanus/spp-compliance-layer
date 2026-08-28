#![no_std]
//! KYC-gated, unlinkable admission into an SPP Association Set.
//!
//! Stellar Private Payments (Nethermind) enforces compliance through an
//! Association Set Provider: `asp-membership`, a Poseidon2 Merkle tree of leaves
//! whose root every pool transaction proves against. A leaf is the pool-side
//! commitment of a note public key (`Poseidon2(notePubKey, blinding, ds = 1)` in
//! SPP's circuits); this contract does not interpret it beyond requiring a BN254
//! scalar-field element. Who gets a leaf into the tree is decided by the tree's
//! admin, off-chain, with the admin learning exactly which person each leaf
//! belongs to.
//!
//! This contract replaces that step. It becomes the admin of an `asp-membership`
//! instance and inserts a leaf only after a transparent, hash-based STARK proof
//! that the requester belongs to the issuer's KYC'd set. The proof shows *a*
//! member asked, never *which* one, to the public and to the pool operator. What
//! it does expose, in the `admit` transaction, is the member's set commitment `C`
//! next to the leaf; the party that assembled the KYC set can map `C` to a person.
//! So the privacy claim is precisely: no leaf-to-person mapping exists outside
//! the KYC issuer. Amount and counterparty privacy stay the pool's job.
//!
//! Two-step admission (commit, then reveal) is what makes the proof unusable by
//! anyone else. The STARK binds `C` and the set root, not the leaf. Without the
//! commit step, a party that sees the proof before inclusion could submit it with
//! its own leaf. Here `admit` only accepts a `(leaf, C)` pair whose hash was
//! committed in an earlier ledger, and `C` is unknown to third parties until the
//! proof itself is published. Each `C` admits one leaf, ever, across admitter
//! generations (`predecessor`).
//!
//! Recovery: the issuer admin can hand the ASP back (`hand_back_asp_admin`), so
//! a bug here cannot brick the tree; `lock_asp` re-asserts admin-only insertion.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec, U256,
};

/// Membership publics layout: `commitment(64) || root(64)` = 128 bytes.
const MEM_PUBLICS_LEN: u32 = 128;
const TTL_THRESHOLD_LEDGERS: u32 = 17_280;
const TTL_TARGET_LEDGERS: u32 = 535_000;

/// BN254 scalar field modulus r (circom / SPP field), big-endian.
pub const BN254_R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

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
    /// Previous admitter generation whose `Used` set still counts.
    pub predecessor: Option<Address>,
}

#[contracttype]
pub enum DataKey {
    Config,
    /// `Used(commitment)`: this member commitment already admitted a leaf.
    Used(Bytes),
    /// `Commit(sha256(leaf_be32 || commitment))` -> ledger sequence of the commit.
    Commit(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    NotInit = 2,
    BadPublics = 3,
    /// The proof's root does not match this issuer's set.
    RootMismatch = 4,
    /// The membership verifier rejected the proof.
    MembershipRejected = 5,
    /// This member commitment already admitted a leaf (here or in a predecessor).
    CommitmentUsed = 6,
    /// The leaf is not a BN254 scalar-field element.
    LeafOutOfField = 7,
    /// No `commit(sha256(leaf || commitment))` on record for this pair.
    NoCommit = 8,
    /// The commit was made in this ledger; reveal must come in a later one.
    CommitTooFresh = 9,
    /// The ASP contract refused the insertion (e.g. tree full).
    AspRejected = 10,
}

#[contractclient(name = "AspClient")]
pub trait AspMembership {
    fn insert_leaf(e: Env, leaf: U256);
    fn update_admin(e: Env, new_admin: Address);
    fn set_admin_insert_only(e: Env, admin_only: bool);
    fn get_root(e: Env) -> U256;
}

#[contractclient(name = "PredecessorClient")]
pub trait Predecessor {
    fn is_used(e: Env, commitment: Bytes) -> bool;
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

fn keep_alive(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_TARGET_LEDGERS);
}

fn in_field(e: &Env, leaf: &U256) -> bool {
    let r = U256::from_be_bytes(e, &Bytes::from_array(e, &BN254_R));
    *leaf < r
}

/// `sha256(leaf_be32 || commitment)`: what a requester commits to before revealing.
pub fn commit_hash(e: &Env, leaf: &U256, commitment: &Bytes) -> BytesN<32> {
    let mut b = leaf.to_be_bytes();
    b.append(commitment);
    e.crypto().sha256(&b).into()
}

#[contract]
pub struct VinelandSppAspAdmitter;

#[contractimpl]
impl VinelandSppAspAdmitter {
    /// Atomic with deployment: no window where a stranger can claim admin.
    pub fn __constructor(
        e: Env,
        admin: Address,
        asp: Address,
        verifier: Address,
        root: BytesN<32>,
        nq: u32,
        lb: u32,
        predecessor: Option<Address>,
    ) {
        e.storage().instance().set(
            &DataKey::Config,
            &Config { admin, asp, verifier, root, nq, lb, predecessor },
        );
        keep_alive(&e);
    }

    /// Step 1 of admission: commit to `sha256(leaf_be32 || commitment)`.
    /// Anyone may commit; a commit only ever unlocks its own `(leaf, C)` pair.
    pub fn commit(e: Env, h: BytesN<32>) -> Result<(), Error> {
        cfg(&e)?;
        let key = DataKey::Commit(h);
        if !e.storage().temporary().has(&key) {
            e.storage().temporary().set(&key, &e.ledger().sequence());
            e.storage().temporary().extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_THRESHOLD_LEDGERS * 2);
        }
        keep_alive(&e);
        Ok(())
    }

    /// Step 2: reveal. Admit `leaf` into the ASP by proving the requester is a
    /// member of the issuer's set. No caller auth: the proof is the credential,
    /// and the prior commit is what binds it to this leaf. One leaf per member
    /// commitment, across generations.
    pub fn admit(e: Env, leaf: U256, mem_proof: Bytes, mem_publics: Bytes) -> Result<(), Error> {
        let c = cfg(&e)?;
        if !in_field(&e, &leaf) {
            return Err(Error::LeafOutOfField);
        }
        if mem_publics.len() != MEM_PUBLICS_LEN {
            return Err(Error::BadPublics);
        }
        let commitment = mem_publics.slice(0..64);
        let root_digest = mem_publics.slice(64..128);
        if keccak32(&e, &root_digest) != c.root {
            return Err(Error::RootMismatch);
        }
        // commit-reveal: the pair must have been committed in an earlier ledger.
        let ckey = DataKey::Commit(commit_hash(&e, &leaf, &commitment));
        let committed_at: u32 = e.storage().temporary().get(&ckey).ok_or(Error::NoCommit)?;
        if committed_at >= e.ledger().sequence() {
            return Err(Error::CommitTooFresh);
        }
        let used_key = DataKey::Used(commitment.clone());
        if e.storage().persistent().has(&used_key) {
            return Err(Error::CommitmentUsed);
        }
        if let Some(prev) = &c.predecessor {
            if PredecessorClient::new(&e, prev).is_used(&commitment) {
                return Err(Error::CommitmentUsed);
            }
        }
        let args: Vec<Val> = (mem_proof, mem_publics, c.nq, c.lb).into_val(&e);
        let ok: bool =
            e.invoke_contract(&c.verifier, &Symbol::new(&e, "verify_crowd_membership"), args);
        if !ok {
            return Err(Error::MembershipRejected);
        }
        // Soroban forbids re-entrancy and rolls the whole frame back on error, so
        // the order below is for clarity, not safety: mark, consume the commit,
        // then insert. A failed insert leaves neither mark nor consumed commit.
        e.storage().persistent().set(&used_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&used_key, TTL_THRESHOLD_LEDGERS, TTL_TARGET_LEDGERS);
        e.storage().temporary().remove(&ckey);
        let asp = AspClient::new(&e, &c.asp);
        if asp.try_insert_leaf(&leaf).is_err() {
            return Err(Error::AspRejected);
        }
        let asp_root = asp.get_root();
        keep_alive(&e);
        KeyAdmitted { leaf, asp_root }.publish(&e);
        Ok(())
    }

    /// Has this member commitment already admitted a leaf in this generation?
    /// (Predecessor generations are consulted inside `admit`.)
    pub fn is_used(e: Env, commitment: Bytes) -> bool {
        e.storage().persistent().has(&DataKey::Used(commitment))
    }

    /// Issuer admin: make sure the ASP only accepts insertions from its admin
    /// (this contract). Call once after `asp.update_admin(this)`.
    pub fn lock_asp(e: Env) -> Result<(), Error> {
        let c = cfg(&e)?;
        c.admin.require_auth();
        AspClient::new(&e, &c.asp).set_admin_insert_only(&true);
        Ok(())
    }

    /// Issuer admin: rotate the issuer set root (new KYC epoch). `Used` marks
    /// are keyed by member commitment and survive the rotation.
    pub fn set_root(e: Env, root: BytesN<32>) -> Result<(), Error> {
        let mut c = cfg(&e)?;
        c.admin.require_auth();
        c.root = root;
        e.storage().instance().set(&DataKey::Config, &c);
        Ok(())
    }

    /// Issuer admin: point at another verifier / FRI parameters.
    pub fn set_verifier(e: Env, verifier: Address, nq: u32, lb: u32) -> Result<(), Error> {
        let mut c = cfg(&e)?;
        c.admin.require_auth();
        c.verifier = verifier;
        c.nq = nq;
        c.lb = lb;
        e.storage().instance().set(&DataKey::Config, &c);
        Ok(())
    }

    /// Issuer admin: hand the ASP's admin role to another address (recovery, or
    /// migration to a new admitter, which should name this one as predecessor).
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

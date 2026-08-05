#![no_std]
//! On-chain verifier and compliance gate for the post-quantum ASP-history
//! attestation.
//!
//! This is the Layer-3 attestation, moved from an off-chain binary into a
//! Soroban contract, and then made load-bearing. `verify` checks a
//! postcard-encoded append-only-history Circle-STARK proof and returns the
//! verdict --- a hash-based, trusted-setup-free, post-quantum check running on
//! Stellar itself. `admit_root` goes further: it verifies, and only if the proof
//! holds does it record the attested endpoint root as compliance-admitted and
//! emit an event. Without a valid post-quantum proof, no root is admitted --- the
//! attestation is not a parallel artifact, it gates on-chain state.
//!
//! `publics` is 19 little-endian u64 limbs: `start_index` (1) followed by
//! `first_root` (9) and `last_root` (9), matching `verify_asp_history`'s public
//! inputs (`ROOT_LIMBS = 9`). `real_rows` and `num_queries` are the AIR height
//! and the FRI query count the proof was produced with; they must match, or the
//! proof does not verify.

extern crate alloc;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Bytes, BytesN, Env, Symbol,
};

use riverrun_m31::asp_history::{verify_asp_history, AspHistoryProof, ROOT_LIMBS};

// 1 (start_index) + ROOT_LIMBS (first_root) + ROOT_LIMBS (last_root).
const PUBLICS_U64S: usize = 1 + 2 * ROOT_LIMBS;
const PUBLICS_BYTES: u32 = (PUBLICS_U64S * 8) as u32;

const EVENT_ADMITTED: Symbol = symbol_short!("admitted");

/// The on-chain security floor, in FRI queries. A proof is only as sound as the
/// query count it was produced with; without a floor, an attacker could grind a
/// cheap low-query proof (e.g. 1 query ~ 9 bits including proof-of-work) of a
/// forged history and have `admit_root` accept it. 40 queries is ~48 classical
/// bits (2^48 grinding, infeasible), the shipped on-chain level. `verify` is the
/// raw primitive and does NOT floor (it exists to measure any point); the gate
/// (`admit_root`) is what enforces this.
const MIN_QUERIES: u32 = 40;

// Persistent-entry TTL management. Soroban archives a persistent entry once its
// TTL lapses; the attestation record must not silently expire, so it is bumped on
// admit and on read. ~30 days of extension, refreshed when it drops below ~1 day.
const TTL_THRESHOLD: u32 = 17_280; // ~1 day at 5s/ledger
const TTL_EXTEND: u32 = 518_400; // ~30 days

/// Persistent storage key: an admitted root, keyed by the keccak256 of its
/// canonical little-endian limbs.
#[contracttype]
pub enum Key {
    Root(BytesN<32>),
}

/// A decoded, verified attestation's public endpoints.
struct Decoded {
    start_index: u64,
    first_root: [u64; ROOT_LIMBS],
    last_root: [u64; ROOT_LIMBS],
}

fn decode_publics(publics: &Bytes) -> Option<Decoded> {
    if publics.len() != PUBLICS_BYTES {
        return None;
    }
    let mut pub_bytes = [0u8; PUBLICS_U64S * 8];
    publics.copy_into_slice(&mut pub_bytes);
    let mut limbs = [0u64; PUBLICS_U64S];
    for (i, chunk) in pub_bytes.chunks_exact(8).enumerate() {
        limbs[i] = u64::from_le_bytes(chunk.try_into().unwrap());
    }
    let mut first_root = [0u64; ROOT_LIMBS];
    let mut last_root = [0u64; ROOT_LIMBS];
    first_root.copy_from_slice(&limbs[1..1 + ROOT_LIMBS]);
    last_root.copy_from_slice(&limbs[1 + ROOT_LIMBS..]);
    Some(Decoded { start_index: limbs[0], first_root, last_root })
}

fn decode_proof(proof: &Bytes) -> Option<AspHistoryProof> {
    let mut buf = alloc::vec![0u8; proof.len() as usize];
    proof.copy_into_slice(&mut buf);
    AspHistoryProof::from_postcard(&buf)
}

fn check(d: &Decoded, proof: &AspHistoryProof, real_rows: u32, num_queries: u32) -> bool {
    verify_asp_history(
        proof,
        d.start_index,
        d.first_root,
        d.last_root,
        real_rows as usize,
        num_queries as usize,
    )
}

/// Hash the last root's canonical LE limbs to a 32-byte key.
fn root_key(env: &Env, root: &[u64; ROOT_LIMBS]) -> BytesN<32> {
    let mut bytes = Bytes::new(env);
    for l in root {
        bytes.extend_from_array(&l.to_le_bytes());
    }
    env.crypto().keccak256(&bytes).to_bytes()
}

#[contract]
pub struct AspHistoryVerifier;

#[contractimpl]
impl AspHistoryVerifier {
    /// Verify a post-quantum append-only-history attestation on-chain (pure:
    /// no state change). Returns `true` iff the proof holds.
    pub fn verify(
        env: Env,
        proof: Bytes,
        publics: Bytes,
        real_rows: u32,
        num_queries: u32,
    ) -> bool {
        let (Some(d), Some(p)) = (decode_publics(&publics), decode_proof(&proof)) else {
            return false;
        };
        let _ = &env; // host-keccak arm reaches the host directly
        check(&d, &p, real_rows, num_queries)
    }

    /// The compliance gate: verify the post-quantum attestation, and ONLY on a
    /// valid proof record the endpoint root as compliance-admitted and emit an
    /// `admitted` event. Panics (rejecting the transaction) if the proof does
    /// not hold, so no root is ever admitted without a valid post-quantum proof.
    ///
    /// Returns the admitted root's index. This is what makes the attestation
    /// load-bearing rather than parallel: on-chain state depends on it.
    pub fn admit_root(
        env: Env,
        proof: Bytes,
        publics: Bytes,
        real_rows: u32,
        num_queries: u32,
    ) -> u64 {
        // Enforce the security floor: a proof below it is cheap to forge, so it
        // must not be able to admit a root regardless of whether it "verifies" at
        // its own weak query count.
        if num_queries < MIN_QUERIES {
            panic!("num_queries below the on-chain security floor; root not admitted");
        }
        if real_rows == 0 {
            panic!("an empty history admits nothing");
        }
        let d = decode_publics(&publics).expect("malformed public values");
        let p = decode_proof(&proof).expect("malformed proof");
        if !check(&d, &p, real_rows, num_queries) {
            panic!("post-quantum attestation did not verify: root not admitted");
        }
        // We store the proof-BOUND start_index, not `start_index + real_rows - 1`.
        // `real_rows` is passed to the verifier to build the AIR, but the AIR does
        // not constrain it (it is not a public value the proof pins), so it is a
        // caller assertion, not proven — deriving stored state from it would let a
        // caller record a forged history length. The history's tip index is
        // therefore NOT stored as fact here; binding it would be an AIR change in
        // riverrun-m31. The security-critical output — that this exact last_root
        // is admitted — is sound: last_root IS a pinned public value.
        let admitted = d.start_index;
        let key = root_key(&env, &d.last_root);
        env.storage().persistent().set(&Key::Root(key.clone()), &admitted);
        // Keep the attestation record from silently expiring (persistent entries
        // are archived once their TTL lapses; without this a root could de-attest
        // and legitimate spends begin to fail).
        env.storage()
            .persistent()
            .extend_ttl(&Key::Root(key.clone()), TTL_THRESHOLD, TTL_EXTEND);
        env.events().publish((EVENT_ADMITTED, key), admitted);
        admitted
    }

    /// Whether a root (identified by the keccak256 of its LE limbs) has been
    /// admitted by a valid post-quantum attestation. A pool or wallet checks
    /// this before honouring a membership proof against that root.
    pub fn is_attested(env: Env, root_key: BytesN<32>) -> bool {
        let key = Key::Root(root_key);
        let present = env.storage().persistent().has(&key);
        // Keep an actively-consulted root alive: reading it bumps its TTL, so a
        // root that is still in use does not age out from under the pool.
        if present {
            env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        }
        present
    }
}

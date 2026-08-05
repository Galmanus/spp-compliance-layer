#![no_std]
//! On-chain verifier for the post-quantum ASP-history attestation.
//!
//! This is the Layer-3 attestation, moved from an off-chain binary into a
//! Soroban contract. It takes the postcard-encoded append-only-history STARK
//! proof and its public values, and returns whether the proof verifies --- a
//! hash-based, trusted-setup-free, post-quantum check running on Stellar itself.
//!
//! `publics` is 19 little-endian u64 limbs: `start_index` (1) followed by
//! `first_root` (9) and `last_root` (9), matching `verify_asp_history`'s public
//! inputs (`ROOT_LIMBS = 9`). `real_rows` and `num_queries` are the AIR height
//! and the FRI query count the proof was produced with; they must match, or the
//! proof does not verify. Any malformed input is a rejection (`false`), never a
//! panic.

extern crate alloc;

use soroban_sdk::{contract, contractimpl, Bytes, Env};

use riverrun_m31::asp_history::{verify_asp_history, AspHistoryProof, ROOT_LIMBS};

// 1 (start_index) + ROOT_LIMBS (first_root) + ROOT_LIMBS (last_root).
const PUBLICS_U64S: usize = 1 + 2 * ROOT_LIMBS;
const PUBLICS_BYTES: u32 = (PUBLICS_U64S * 8) as u32;

#[contract]
pub struct AspHistoryVerifier;

#[contractimpl]
impl AspHistoryVerifier {
    /// Verify a post-quantum append-only-history attestation on-chain.
    ///
    /// Returns `true` iff `proof` is a valid Circle-STARK proof that the root
    /// history is an honest append-only chain with the given public endpoints.
    pub fn verify(
        env: Env,
        proof: Bytes,
        publics: Bytes,
        real_rows: u32,
        num_queries: u32,
    ) -> bool {
        if publics.len() != PUBLICS_BYTES {
            return false;
        }

        // Decode the proof from its postcard wire form.
        let mut proof_buf = alloc::vec![0u8; proof.len() as usize];
        proof.copy_into_slice(&mut proof_buf);
        let Some(proof) = AspHistoryProof::from_postcard(&proof_buf) else {
            return false;
        };

        // Decode the 19 little-endian u64 public limbs.
        let mut pub_bytes = [0u8; PUBLICS_U64S * 8];
        publics.copy_into_slice(&mut pub_bytes);
        let mut limbs = [0u64; PUBLICS_U64S];
        for (i, chunk) in pub_bytes.chunks_exact(8).enumerate() {
            limbs[i] = u64::from_le_bytes(chunk.try_into().unwrap());
        }

        let start_index = limbs[0];
        let mut first_root = [0u64; ROOT_LIMBS];
        let mut last_root = [0u64; ROOT_LIMBS];
        first_root.copy_from_slice(&limbs[1..1 + ROOT_LIMBS]);
        last_root.copy_from_slice(&limbs[1 + ROOT_LIMBS..]);

        let _ = &env; // the host-keccak arm reaches the host directly
        verify_asp_history(
            &proof,
            start_index,
            first_root,
            last_root,
            real_rows as usize,
            num_queries as usize,
        )
    }
}

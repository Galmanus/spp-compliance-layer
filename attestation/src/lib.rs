//! Shared parameters for the two attestation binaries.
//!
//! The prover and the verifier MUST agree on the query count: a proof made with
//! one `num_queries` does not verify under another. Keeping the number in one
//! place is the only way to guarantee they cannot drift.

/// FRI query count for the append-only-history STARK.
///
/// Security accounting (from riverrun-m31's own `qm31_ceiling.rs`, the
/// round-by-round soundness formula, at `log_blowup = 1` over the QM31 degree-4
/// challenge field, plus 8 proof-of-work bits):
///
/// | queries | classical bits | quantum bits (Grover) |
/// |--------:|---------------:|----------------------:|
/// |      20 |             28 |                    14 |
/// |      96 |            104 |                    52 |
/// |     128 |            124 |                    62 |
///
/// 128 queries sits at the ceiling this construction can reach: with the QM31
/// field (|E| ~ 2^124) and `log_blowup = 1`, the additive soundness terms bind
/// at ~124 classical bits, so more queries buy nothing. Exceeding 62 quantum
/// bits requires raising `log_blowup` in the STARK crate's `make_config` — a
/// change in riverrun-m31, not here. This is the honest ceiling, chosen
/// deliberately over the earlier 20, whose 14 quantum bits were too few to call
/// the attestation post-quantum in any meaningful sense.
pub const NUM_QUERIES: usize = 128;

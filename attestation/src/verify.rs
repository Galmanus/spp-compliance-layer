//! verify-asp-history — the other half a regulator actually needs.
//!
//! Attestation without verification is a claim, not a proof. This binary takes
//! an attestation produced by `attest-asp-history` and its public values, and
//! checks — with the same hash-based Circle-STARK, no trusted setup — that the
//! ASP root history really is a consistent append-only chain ending at the root
//! the regulator was told to expect.
//!
//! The point of separating prove from verify is trust: the party proving and
//! the party checking are different people, and the verifier must be runnable
//! by the second without the first. A `true` here means the published root is
//! the honest tail of a chain whose every step advanced the index by one — a
//! reordered or leaf-injected history could not have produced this proof.
//!
//! ## Usage
//!
//! ```text
//! verify-asp-history <attestation.postcard> <start_index> <first_root_limbs> \
//!                    <last_root_limbs> <events>
//! ```
//!
//! The limb arguments are the hex strings `attest-asp-history` printed. `events`
//! is the number of real root updates the attestation covers.

use riverrun_m31::asp_history::{verify_asp_history, AspHistoryProof, ROOT_LIMBS};
use std::fs;

/// Parse the concatenated 8-hex-char limbs that `attest-asp-history` prints
/// (`{l:08x}` per limb) back into the limb array the verifier compares against.
fn parse_limbs(hex: &str) -> [u64; ROOT_LIMBS] {
    let mut limbs = [0u64; ROOT_LIMBS];
    for (i, limb) in limbs.iter_mut().enumerate() {
        let start = i * 8;
        if start + 8 <= hex.len() {
            *limb = u64::from_str_radix(&hex[start..start + 8], 16).unwrap_or(0);
        }
    }
    limbs
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        eprintln!(
            "usage: verify-asp-history <attestation.postcard> <start_index> \
             <first_root_limbs> <last_root_limbs> <events>"
        );
        std::process::exit(2);
    }

    let bytes = fs::read(&args[1]).expect("read attestation");
    let proof = AspHistoryProof::from_postcard(&bytes).expect("parse attestation");
    let start_index: u64 = args[2].parse().expect("start_index");
    let first_root = parse_limbs(&args[3]);
    let last_root = parse_limbs(&args[4]);
    let events: usize = args[5].parse().expect("events");

    let ok = verify_asp_history(&proof, start_index, first_root, last_root, events, spp_attestation::NUM_QUERIES);

    if ok {
        println!(
            "VALID: an honest append-only chain of {events} root updates ending at the \
             attested root. No trusted setup was involved and no quantum adversary can \
             forge the ordering."
        );
        std::process::exit(0);
    } else {
        println!(
            "INVALID: this attestation does not verify against those public values. The \
             history is not the append-only chain claimed, or the roots do not match."
        );
        std::process::exit(1);
    }
}

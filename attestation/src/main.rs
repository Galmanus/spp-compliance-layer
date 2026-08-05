//! attest-asp-history — the Layer-3 post-quantum attestation binary.
//!
//! This is the Rust half of the spp-compliance-layer. The Node CLI captures an
//! ASP root history that the RPC will delete; this proves that history is an
//! honest append-only chain with a hash-based Circle-STARK — no trusted setup,
//! nothing a quantum adversary undoes — and writes the proof plus its public
//! values for a verifier or an on-chain contract.
//!
//! The append-only-history AIR itself lives in `riverrun-m31::asp_history`
//! (this project's post-quantum STARK crate); this binary is the thin,
//! self-contained driver so a bare clone of THIS repository builds and runs the
//! attestation without a separate checkout.
//!
//! ## What the AIR proves, in one sentence
//!
//! Given the `LeafAddedEvent(leaf, index, root)` steps of an ASP, the STARK
//! proves the indices are `0, 1, 2, …` with no gap, each root chains from the
//! previous, and the endpoints match public values — so a reordered or
//! leaf-injected history is *unprovable*, whatever the hash's strength. The
//! BN254-Poseidon2 compression the ASP uses is a witnessed oracle here, not
//! reproven: the compliance property is the shape of the history, and reproving
//! a pairing-field hash inside an M31 STARK is out of scope (and stated so).
//!
//! ## Usage
//!
//! ```text
//! attest-asp-history <steps.json> <outdir>
//! ```
//!
//! `steps.json` is `[{"index": u64, "root": "0x…"}, …]` — the rows the Node
//! index emits from its `asp_roots` table. The output directory receives
//! `attestation.postcard`; the public values are printed as one JSON line.

use riverrun_m31::asp_history::{prove_asp_history, root_to_limbs, RootStep, ROOT_LIMBS};
use std::fs;

/// Parse a BN254 root hex string into the tag limbs the AIR carries. The AIR
/// does no arithmetic on the root — it is a witnessed label — so this only has
/// to be injective on distinct roots, which `root_to_limbs` guarantees.
fn parse_root_hex(h: &str) -> [u64; ROOT_LIMBS] {
    let h = h.trim_start_matches("0x");
    // Left-pad to even length so odd-length hex (e.g. "0x1") parses.
    let padded = if h.len() % 2 == 1 { format!("0{h}") } else { h.to_string() };
    let mut be = [0u8; 32];
    let bytes: Vec<u8> = (0..padded.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&padded[i..i + 2], 16).unwrap_or(0))
        .collect();
    let start = 32usize.saturating_sub(bytes.len());
    be[start..start + bytes.len().min(32)].copy_from_slice(&bytes[..bytes.len().min(32)]);
    root_to_limbs(&be)
}

/// Minimal JSON reader for the array of `{"index", "root"}` steps. Deliberately
/// dependency-free — the shape is fixed and produced by this project's own Node
/// index, so a full JSON crate would be weight for no safety here.
fn parse_steps(raw: &str) -> Vec<RootStep> {
    let mut steps = Vec::new();
    for chunk in raw.split('{').skip(1) {
        let index = chunk
            .split("\"index\"")
            .nth(1)
            .and_then(|s| s.split(|c: char| c == ':' || c == ',' || c == '}').nth(1))
            .and_then(|s| s.trim().parse::<u64>().ok());
        let root = chunk
            .split("\"root\"")
            .nth(1)
            .and_then(|s| s.split('"').nth(1))
            .map(parse_root_hex);
        if let (Some(index), Some(root)) = (index, root) {
            steps.push(RootStep { index, root });
        }
    }
    steps
}

fn hex_limbs(limbs: &[u64; ROOT_LIMBS]) -> String {
    limbs.iter().map(|l| format!("{l:08x}")).collect()
}

/// Write the public values as raw little-endian u64 limbs, exactly the byte
/// layout the on-chain verifier decodes: start_index (1) ‖ first_root (ROOT_LIMBS)
/// ‖ last_root (ROOT_LIMBS).
fn write_publics_bin(path: &str, steps: &[RootStep]) {
    let mut buf = Vec::with_capacity((1 + 2 * ROOT_LIMBS) * 8);
    buf.extend_from_slice(&steps[0].index.to_le_bytes());
    for l in steps[0].root {
        buf.extend_from_slice(&l.to_le_bytes());
    }
    for l in steps[steps.len() - 1].root {
        buf.extend_from_slice(&l.to_le_bytes());
    }
    fs::write(path, &buf).unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: attest-asp-history <steps.json> <outdir> [num_queries]");
        std::process::exit(2);
    }

    let raw = fs::read_to_string(&args[1]).expect("read steps json");
    let outdir = &args[2];
    // Optional query count: defaults to the shipped off-chain security level.
    // A smaller count (e.g. 40) produces a proof that verifies ON-CHAIN inside a
    // single Soroban transaction's CPU budget; see onchain-verifier/.
    let num_queries = args
        .get(3)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(spp_attestation::NUM_QUERIES);
    fs::create_dir_all(outdir).unwrap();

    let steps = parse_steps(&raw);
    assert!(!steps.is_empty(), "no steps parsed — an empty history attests nothing");
    let events = steps.len();

    // Smallest committed height that fits the history; CirclePcs needs >= 4 rows.
    let log_rows = (events.next_power_of_two().trailing_zeros() as usize).max(2);
    let proof = prove_asp_history(&steps, log_rows, num_queries);
    let bytes = proof.to_postcard();

    let proof_path = format!("{outdir}/attestation.postcard");
    fs::write(&proof_path, &bytes).unwrap();
    let publics_path = format!("{outdir}/publics.bin");
    write_publics_bin(&publics_path, &steps);

    // Public values a verifier checks the proof against: the start index and
    // the first and last roots, pinned by the AIR's first- and last-row
    // constraints so the proof cannot be about a different history.
    println!(
        "{{\"proof\":\"{proof_path}\",\"publics\":\"{publics_path}\",\"proof_bytes\":{},\"events\":{events},\"real_rows\":{events},\"num_queries\":{num_queries},\"start_index\":{},\"first_root_limbs\":\"{}\",\"last_root_limbs\":\"{}\"}}",
        bytes.len(),
        steps[0].index,
        hex_limbs(&steps[0].root),
        hex_limbs(&steps[events - 1].root),
    );
}

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

/// Parse a BN254 root into the tag limbs the AIR carries. The AIR does no
/// arithmetic on the root — it is a witnessed label — so this only has to be
/// injective on distinct roots, which `root_to_limbs` over the canonical 32-byte
/// big-endian form guarantees.
///
/// The index emits roots as DECIMAL strings (U256 canonicalized in
/// `lib/decode.mjs`), so decimal is the primary path; a `0x`-prefixed hex string
/// is also accepted for robustness. An earlier version parsed the decimal string
/// AS hex and truncated 38→32 bytes, which was not injective on full-width BN254
/// roots — corrected here to a faithful decimal→bytes conversion.
fn parse_root(s: &str) -> [u64; ROOT_LIMBS] {
    let s = s.trim();
    let be = match s.strip_prefix("0x") {
        Some(hex) => hex_to_be32(hex),
        None => decimal_to_be32(s),
    };
    root_to_limbs(&be)
}

/// A decimal integer string to 32 big-endian bytes, by repeated division by 256.
/// Each division step's remainder is the next least-significant byte.
fn decimal_to_be32(dec: &str) -> [u8; 32] {
    let mut digits: Vec<u8> = dec.bytes().filter(u8::is_ascii_digit).map(|b| b - b'0').collect();
    if digits.is_empty() {
        return [0u8; 32];
    }
    let mut le = Vec::new();
    while digits.iter().any(|&d| d != 0) {
        let mut carry = 0u32;
        for d in digits.iter_mut() {
            let cur = carry * 10 + *d as u32; // carry < 256, so cur/256 <= 9: a valid digit
            *d = (cur / 256) as u8;
            carry = cur % 256;
        }
        le.push(carry as u8);
    }
    // A BN254 root is < 2^254, so it fits in 32 bytes. A value that does not is not
    // a valid field element; reject it rather than silently truncate, which would
    // break the injective-label invariant `parse_root` relies on.
    assert!(le.len() <= 32, "root value exceeds 256 bits; not a valid field element");
    let mut be = [0u8; 32];
    for (i, b) in le.iter().enumerate() {
        be[31 - i] = *b;
    }
    be
}

/// A hex string to 32 big-endian bytes, right-aligned (low bytes preserved).
/// Works on ASCII bytes (non-hex bytes are dropped), so a non-ASCII input cannot
/// panic on a char-boundary slice.
fn hex_to_be32(h: &str) -> [u8; 32] {
    let nibble = |b: u8| (b as char).to_digit(16).unwrap_or(0) as u8;
    let mut nibbles: Vec<u8> = h.bytes().filter(u8::is_ascii_hexdigit).collect();
    if nibbles.len() % 2 == 1 {
        nibbles.insert(0, b'0'); // left-pad to a whole byte
    }
    let bytes: Vec<u8> = nibbles.chunks(2).map(|c| (nibble(c[0]) << 4) | nibble(c[1])).collect();
    assert!(bytes.len() <= 32, "root value exceeds 256 bits; not a valid field element");
    let mut be = [0u8; 32];
    let take = bytes.len().min(32);
    be[32 - take..].copy_from_slice(&bytes[bytes.len() - take..]);
    be
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
            .map(parse_root);
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

#[cfg(test)]
mod tests {
    use super::{decimal_to_be32, hex_to_be32, parse_root};

    #[test]
    fn small_decimals_are_big_endian() {
        assert_eq!(decimal_to_be32("0"), [0u8; 32]);
        let mut e = [0u8; 32];
        e[31] = 255;
        assert_eq!(decimal_to_be32("255"), e);
        let mut e = [0u8; 32];
        e[30] = 1;
        e[31] = 0;
        assert_eq!(decimal_to_be32("256"), e);
    }

    #[test]
    fn decimal_and_hex_of_one_value_agree() {
        // 255, 256, and a wider value, in both forms.
        assert_eq!(decimal_to_be32("255"), hex_to_be32("ff"));
        assert_eq!(decimal_to_be32("256"), hex_to_be32("100"));
        assert_eq!(decimal_to_be32("18446744073709551619"), hex_to_be32("10000000000000003"));
        assert_eq!(parse_root("255"), parse_root("0xff"));
    }

    #[test]
    fn a_full_width_bn254_root_round_trips_faithfully() {
        // The real first root of the demo history, decimal, must map to the exact
        // 32 big-endian bytes of that integer. The bug this replaced parsed the
        // decimal AS hex and dropped the high bytes; here the high byte survives.
        let dec = "9667236958756909525649769644727778012477910539601936707706602150991285581632";
        let be = decimal_to_be32(dec);
        assert_ne!(be[0], 0, "the high byte must survive; the old bug dropped it");
        // decimal and the equivalent hex agree byte for byte (0x155f7653… computed
        // independently as the hex of the decimal above)
        assert_eq!(
            be,
            hex_to_be32("155f7653e0306cc8d7fa1416069cf7961b1a60c2c23631f032019e6e6661f740")
        );
    }

    #[test]
    fn distinct_roots_differing_only_high_produce_distinct_labels() {
        // Injectivity where the old truncating parser collided: two values equal
        // in their low bytes but different high must map to different labels.
        let a = "1".to_string() + &"0".repeat(70); // 10^70, differs high
        let b = "2".to_string() + &"0".repeat(70); // 2*10^70
        assert_ne!(parse_root(&a), parse_root(&b));
        assert_ne!(decimal_to_be32(&a), decimal_to_be32(&b));
    }
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

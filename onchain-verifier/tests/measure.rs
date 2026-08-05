//! Feasibility measurement: does the post-quantum ASP-history attestation verify
//! ON-CHAIN, within Soroban's per-transaction CPU budget?
//!
//! This imports the REAL optimized wasm and calls it through the metered host,
//! so the instruction counts are what a Stellar transaction would actually be
//! charged (not a native approximation, which understates wasm cost). The tx CPU
//! cap is 100,000,000 model units; the crowd-probe measurements express it as a
//! percentage of a 4,000,000 divisor used there, so we report both raw and the
//! fraction of the 400M-instruction envelope.

use riverrun_m31::asp_history::{prove_asp_history, RootStep, ROOT_LIMBS};
use soroban_sdk::{Bytes, Env};

mod wasmcontract {
    soroban_sdk::contractimport!(
        file = "target/wasm32v1-none/release/spp_onchain_verifier.optimized.wasm"
    );
}

fn root(seed: u64) -> [u64; ROOT_LIMBS] {
    core::array::from_fn(|i| (seed.wrapping_mul(1000).wrapping_add(i as u64)) % ((1 << 31) - 1))
}

fn history(n: usize) -> Vec<RootStep> {
    (0..n)
        .map(|i| RootStep { index: i as u64, root: root(i as u64 + 1) })
        .collect()
}

fn publics_le(steps: &[RootStep]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&steps[0].index.to_le_bytes());
    for l in steps[0].root {
        v.extend_from_slice(&l.to_le_bytes());
    }
    for l in steps[steps.len() - 1].root {
        v.extend_from_slice(&l.to_le_bytes());
    }
    v
}

#[test]
fn onchain_cpu_across_query_counts() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let id = env.register(wasmcontract::WASM, ());
    let client = wasmcontract::Client::new(&env, &id);

    let steps = history(15); // the real demonstration size: 15 leaves
    let log_rows = 4; // next_power_of_two(15) = 16 -> 2^4
    let real_rows = steps.len() as u32;

    std::println!("\n== on-chain verify of the post-quantum ASP-history attestation (15 leaves) ==");
    for q in [8u32, 16, 20, 27, 40] {
        let proof = prove_asp_history(&steps, log_rows, q as usize);
        let bytes = proof.to_postcard();
        let pubs = publics_le(&steps);

        env.cost_estimate().budget().reset_unlimited();
        let ok = client.verify(
            &Bytes::from_slice(&env, &bytes),
            &Bytes::from_slice(&env, &pubs),
            &real_rows,
            &q,
        );
        let cpu = env.cost_estimate().budget().cpu_instruction_cost();
        std::println!(
            "{:>3}q: ACCEPT={ok}  cpu_insns={:>11}  ({:>5.1}% of 400M tx cap)  proof {} B",
            q,
            cpu,
            cpu as f64 / 4_000_000.0,
            bytes.len(),
        );
        assert!(ok, "{q}q honest proof must verify on-chain");
    }
}

#[test]
fn admit_root_gates_state_on_a_valid_proof() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let id = env.register(wasmcontract::WASM, ());
    let client = wasmcontract::Client::new(&env, &id);

    let steps = history(15);
    let proof = prove_asp_history(&steps, 4, 40);
    let bytes = proof.to_postcard();
    let pubs = publics_le(&steps);

    env.cost_estimate().budget().reset_unlimited();
    let idx = client.admit_root(
        &Bytes::from_slice(&env, &bytes),
        &Bytes::from_slice(&env, &pubs),
        &(steps.len() as u32),
        &40u32,
    );
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!(
        "\n[admit_root] 40q: verify + store + event = {} cpu_insns ({:.1}% of 400M cap), admitted start_index {}",
        cpu,
        cpu as f64 / 4_000_000.0,
        idx,
    );
    // admit_root returns the proof-BOUND start_index (0 here), not a real_rows-
    // derived tip index (real_rows is not constrained by the AIR, so it is not
    // treated as authenticated).
    assert_eq!(idx, 0, "start_index is 0 and is a pinned public value");

    // the gated state now reflects the admitted root
    let key = root_key(&env, &steps[steps.len() - 1].root);
    assert!(client.is_attested(&key), "admitted root must read back as attested");

    // a root that was never admitted is not attested
    let other = root_key(&env, &steps[0].root);
    assert!(!client.is_attested(&other), "an un-admitted root must not be attested");
}

#[test]
#[should_panic]
fn admit_root_rejects_a_proof_below_the_security_floor() {
    // A proof made at 8 queries is cheap to forge; even though it "verifies" at
    // 8 queries, admit_root must refuse it (the security floor is 40). Without
    // this floor, an attacker grinds a low-query proof of a forged history and
    // gets a root admitted.
    let env = Env::default();
    let id = env.register(wasmcontract::WASM, ());
    let client = wasmcontract::Client::new(&env, &id);

    let steps = history(15);
    let proof = prove_asp_history(&steps, 4, 8); // 8 queries, an honest but weak proof
    let bytes = proof.to_postcard();
    let pubs = publics_le(&steps);

    // must panic on the floor, before it even matters that the proof is honest
    client.admit_root(
        &Bytes::from_slice(&env, &bytes),
        &Bytes::from_slice(&env, &pubs),
        &(steps.len() as u32),
        &8u32,
    );
}

#[test]
#[should_panic]
fn admit_root_rejects_a_tampered_proof_and_changes_no_state() {
    let env = Env::default();
    let id = env.register(wasmcontract::WASM, ());
    let client = wasmcontract::Client::new(&env, &id);

    let steps = history(15);
    let proof = prove_asp_history(&steps, 4, 40);
    let bytes = proof.to_postcard();
    let mut pubs = publics_le(&steps);
    let n = pubs.len();
    pubs[n - 1] ^= 1; // tamper the last root limb

    // must panic: no root admitted without a valid post-quantum proof
    client.admit_root(
        &Bytes::from_slice(&env, &bytes),
        &Bytes::from_slice(&env, &pubs),
        &(steps.len() as u32),
        &40u32,
    );
}

// keccak256 of the LE limbs, mirroring the contract's root_key, for the test to
// look up admitted roots.
fn root_key(env: &Env, root: &[u64; ROOT_LIMBS]) -> soroban_sdk::BytesN<32> {
    let mut bytes = Bytes::new(env);
    for l in root {
        bytes.extend_from_array(&l.to_le_bytes());
    }
    env.crypto().keccak256(&bytes).to_bytes()
}

#[test]
fn onchain_rejects_a_tampered_root() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let id = env.register(wasmcontract::WASM, ());
    let client = wasmcontract::Client::new(&env, &id);

    let steps = history(15);
    let proof = prove_asp_history(&steps, 4, 20);
    let bytes = proof.to_postcard();

    // Flip one limb of the last root in the public values.
    let mut pubs = publics_le(&steps);
    let n = pubs.len();
    pubs[n - 1] ^= 1;

    let ok = client.verify(
        &Bytes::from_slice(&env, &bytes),
        &Bytes::from_slice(&env, &pubs),
        &(steps.len() as u32),
        &20u32,
    );
    assert!(!ok, "a tampered final root must be rejected on-chain");
}

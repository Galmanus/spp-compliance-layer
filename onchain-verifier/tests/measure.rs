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

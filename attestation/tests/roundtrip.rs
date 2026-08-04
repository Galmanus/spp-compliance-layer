//! Prove then verify, and confirm the attestation rejects a tampered claim.
//!
//! These run the actual STARK — not a mock — so they are the ground truth that
//! the two binaries wrap. A regulator's whole trust rests on the last test:
//! that a proof of one history does not verify against a different final root.

use riverrun_m31::asp_history::{
    prove_asp_history, verify_asp_history, RootStep, ROOT_LIMBS,
};

fn root(seed: u64) -> [u64; ROOT_LIMBS] {
    core::array::from_fn(|i| (seed.wrapping_mul(1000).wrapping_add(i as u64)) % ((1 << 31) - 1))
}

fn history(n: usize) -> Vec<RootStep> {
    (0..n)
        .map(|i| RootStep { index: i as u64, root: root(i as u64 + 1) })
        .collect()
}

#[test]
fn an_honest_history_attests_and_verifies() {
    let steps = history(8);
    let proof = prove_asp_history(&steps, 3, 20);
    assert!(verify_asp_history(
        &proof,
        steps[0].index,
        steps[0].root,
        steps[steps.len() - 1].root,
        steps.len(),
        20,
    ));
}

#[test]
fn a_different_final_root_is_rejected() {
    let steps = history(8);
    let proof = prove_asp_history(&steps, 3, 20);
    let mut wrong = steps[steps.len() - 1].root;
    wrong[0] ^= 1;
    assert!(!verify_asp_history(
        &proof, steps[0].index, steps[0].root, wrong, steps.len(), 20
    ));
}

#[test]
fn a_reordered_history_never_verifies() {
    // Swapping two events breaks the monotone-index constraint. In a debug build
    // the prover's constraint check fails closed and panics; in release it emits
    // a proof of the unsatisfiable trace that CANNOT verify. Both are safe — an
    // adversary never obtains a proof that verifies for a forged history — and
    // this test asserts the property that holds in both: reordering does not
    // verify. Written as a catch so it passes in debug and release alike.
    let mut steps = history(8);
    steps.swap(2, 5);
    let attempted = std::panic::catch_unwind(|| prove_asp_history(&steps, 3, 20));
    match attempted {
        Err(_) => { /* debug: fail-closed at proving */ }
        Ok(proof) => {
            let verified = verify_asp_history(
                &proof, steps[0].index, steps[0].root,
                steps[steps.len() - 1].root, steps.len(), 20,
            );
            assert!(!verified, "SECURITY: a reordered history both proved and verified");
        }
    }
}


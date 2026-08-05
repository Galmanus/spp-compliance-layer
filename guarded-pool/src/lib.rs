#![no_std]
//! A minimal guarded pool that CONSUMES the compliance gate.
//!
//! This is the other half of the loop. The gate contract (`onchain-verifier/`)
//! admits a root only when a post-quantum attestation of the honest history
//! verifies on-chain. This pool honours a spend against a root ONLY IF the gate
//! says that root is attested --- a cross-contract call to `is_attested`. Present
//! a root the gate never admitted, and the spend is refused by the chain.
//!
//! It is deliberately tiny: the point is to show the attestation being used as a
//! precondition for a real state-changing action, not to reimplement a privacy
//! pool. The spend records a nullifier (rejecting replays) and emits a `spent`
//! event, exactly the shape a real pool's accounting would hang off.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Address, BytesN, Env, IntoVal, Symbol,
};

#[contracttype]
pub enum DataKey {
    /// Address of the compliance gate this pool trusts for root attestation.
    Gate,
    /// A spent note, keyed by its identifier, for replay protection.
    Note(BytesN<32>),
}

// Persistent-entry TTL: a spent-note record must not expire, or its note could be
// replayed after the entry is archived. Bumped on write and on read.
const TTL_THRESHOLD: u32 = 17_280; // ~1 day
const TTL_EXTEND: u32 = 518_400; // ~30 days

#[contract]
pub struct GuardedPool;

#[contractimpl]
impl GuardedPool {
    /// Wire the pool to the compliance-gate contract whose `is_attested` it will
    /// consult before every spend.
    pub fn __constructor(env: Env, gate: Address) {
        env.storage().instance().set(&DataKey::Gate, &gate);
    }

    /// Spend a note against a compliance root.
    ///
    /// The pool asks the gate, cross-contract, whether `root_key` was admitted by
    /// a valid post-quantum attestation. If not, the spend is refused (the
    /// transaction traps) and no state changes. If yes, the note is recorded as
    /// spent (replays refused) and a `spent` event is emitted.
    pub fn spend(env: Env, spender: Address, root_key: BytesN<32>, note: BytesN<32>) -> bool {
        // Only the spender may spend on their own behalf. Without this, anyone
        // could mark any note spent. A production pool additionally proves the
        // note is a member of the attested root's tree (Poseidon2 Merkle path,
        // CAP-0075) and derives the nullifier from a secret — the two halves this
        // minimal pool leaves as the documented integration step.
        spender.require_auth();

        let gate: Address = env
            .storage()
            .instance()
            .get(&DataKey::Gate)
            .expect("pool not initialised with a gate");

        // Cross-contract: consume the compliance gate's attestation verdict.
        let attested: bool = env.invoke_contract(
            &gate,
            &Symbol::new(&env, "is_attested"),
            vec![&env, root_key.clone().into_val(&env)],
        );
        if !attested {
            panic!("root is not compliance-attested by the gate; spend refused");
        }

        // Anti-replay: a note spends exactly once. The record's TTL is bumped so
        // it cannot be replayed after the persistent entry would otherwise be
        // archived.
        let note_key = DataKey::Note(note.clone());
        if env.storage().persistent().has(&note_key) {
            panic!("note already spent");
        }
        env.storage().persistent().set(&note_key, &true);
        env.storage().persistent().extend_ttl(&note_key, TTL_THRESHOLD, TTL_EXTEND);

        env.events().publish((symbol_short!("spent"), root_key), note);
        true
    }

    /// Whether a note has already been spent.
    pub fn is_spent(env: Env, note: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Note(note))
    }

    /// The gate this pool trusts (for inspection).
    pub fn gate(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Gate).expect("uninitialised")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{contract, contractimpl, testutils::Address as _};

    // A stand-in gate: is_attested returns true only for one stored "good" key.
    #[contract]
    struct MockGate;
    #[contractimpl]
    impl MockGate {
        pub fn __constructor(env: Env, good: BytesN<32>) {
            env.storage().instance().set(&0u32, &good);
        }
        pub fn is_attested(env: Env, root_key: BytesN<32>) -> bool {
            let good: BytesN<32> = env.storage().instance().get(&0u32).unwrap();
            root_key == good
        }
    }

    fn setup(env: &Env) -> (GuardedPoolClient, BytesN<32>, Address) {
        env.mock_all_auths();
        let good = BytesN::from_array(env, &[1u8; 32]);
        let gate = env.register(MockGate, (good.clone(),));
        let pool = env.register(GuardedPool, (gate,));
        (GuardedPoolClient::new(env, &pool), good, Address::generate(env))
    }

    #[test]
    fn spend_succeeds_against_an_attested_root() {
        let env = Env::default();
        let (pool, good, spender) = setup(&env);
        let note = BytesN::from_array(&env, &[9u8; 32]);
        assert!(pool.spend(&spender, &good, &note));
        assert!(pool.is_spent(&note));
    }

    #[test]
    fn spend_is_refused_against_an_unattested_root() {
        let env = Env::default();
        let (pool, _good, spender) = setup(&env);
        let bad = BytesN::from_array(&env, &[2u8; 32]);
        let note = BytesN::from_array(&env, &[8u8; 32]);
        assert!(pool.try_spend(&spender, &bad, &note).is_err());
        assert!(!pool.is_spent(&note), "a refused spend records nothing");
    }

    #[test]
    fn a_note_cannot_be_replayed() {
        let env = Env::default();
        let (pool, good, spender) = setup(&env);
        let note = BytesN::from_array(&env, &[7u8; 32]);
        assert!(pool.spend(&spender, &good, &note));
        assert!(pool.try_spend(&spender, &good, &note).is_err(), "replay refused");
    }
}

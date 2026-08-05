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
    pub fn spend(env: Env, root_key: BytesN<32>, note: BytesN<32>) -> bool {
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

        // Anti-replay: a note spends exactly once.
        let note_key = DataKey::Note(note.clone());
        if env.storage().persistent().has(&note_key) {
            panic!("note already spent");
        }
        env.storage().persistent().set(&note_key, &true);

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

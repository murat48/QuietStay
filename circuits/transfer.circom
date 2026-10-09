pragma circom 2.2.2;

// QuietStay Phase 2 — the ownership proof. Specification: docs/CIRCUIT.md.
//
// Proves, for one transfer of one usage right:
//   - the prover knows the secret s behind the commitment the ledger stores, and
//     that commitment names the sending account;
//   - the nullifier is the one this exact transfer produces from s;
//   - the next commitment wraps the same record digest for the recipient.
//
// Compiled for BLS12-381 (`circom -p bls12381`), against Poseidon constants
// generated for that field — see circuits/poseidon/ and docs/CIRCUIT.md.

include "./lib/poseidon.circom";

template QuietStayTransfer() {
    // ---- public, in the order the verifier receives them (CIRCUIT.md §7) ----
    // Declared as inputs with equality constraints and no outputs, so snarkjs
    // emits them in exactly this declaration order.
    signal input commitment;        //  1  C, the commitment stored for right_id
    signal input nullifier;         //  2  N, refused if already used
    signal input right_id;          //  3
    signal input from_hi;           //  4  sender's Ed25519 key, bytes 0..16, big-endian
    signal input from_lo;           //  5  sender's Ed25519 key, bytes 16..32
    signal input to_hi;             //  6  recipient's key, bytes 0..16
    signal input to_lo;             //  7  recipient's key, bytes 16..32
    signal input mode;              //  8  0 = sale; a rental's end time otherwise
    signal input expiry_ledger;     //  9  last ledger at which this proof is accepted
    signal input next_secret_hash;  // 10  h' = Poseidon(s'), signed by the buyer; 0 on a rental
    signal input next_commitment;   // 11  C', stored on a sale, ignored on a rental

    // ---- private ----
    signal input d_hi;              // record digest d = SHA-256(canonical record), bytes 0..16
    signal input d_lo;              // bytes 16..32
    signal input secret;            // s

    // h = Poseidon_1(s)
    component h = Poseidon(1);
    h.inputs[0] <== secret;

    // C === Poseidon_5(d_hi, d_lo, from_hi, from_lo, h)
    component c = Poseidon(5);
    c.inputs[0] <== d_hi;
    c.inputs[1] <== d_lo;
    c.inputs[2] <== from_hi;
    c.inputs[3] <== from_lo;
    c.inputs[4] <== h.out;
    commitment === c.out;

    // N === Poseidon_6(s, right_id, to_hi, to_lo, mode, expiry_ledger)
    component n = Poseidon(6);
    n.inputs[0] <== secret;
    n.inputs[1] <== right_id;
    n.inputs[2] <== to_hi;
    n.inputs[3] <== to_lo;
    n.inputs[4] <== mode;
    n.inputs[5] <== expiry_ledger;
    nullifier === n.out;

    // C' === Poseidon_5(d_hi, d_lo, to_hi, to_lo, h')
    component next = Poseidon(5);
    next.inputs[0] <== d_hi;
    next.inputs[1] <== d_lo;
    next.inputs[2] <== to_hi;
    next.inputs[3] <== to_lo;
    next.inputs[4] <== next_secret_hash;
    next_commitment === next.out;
}

component main {public [
    commitment,
    nullifier,
    right_id,
    from_hi,
    from_lo,
    to_hi,
    to_lo,
    mode,
    expiry_ledger,
    next_secret_hash,
    next_commitment
]} = QuietStayTransfer();

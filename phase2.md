# QuietStay Phase 2 — ZK-proof-gated transfers on Stellar testnet

You are working in the QuietStay repository. Phase 1 is complete and live
(see README.md and docs/). Phase 2 has an approved Statement of Work, and your
job is to implement it faithfully. The SOW is the contract: do not add scope,
do not drop scope, and do not change an approved technical choice without
stopping to ask me first.

## What Phase 2 must achieve

At the end of 30 days, rentals and sales on Stellar testnet are authorized by
on-chain ZK-proof verification (Groth16 on BLS12-381) instead of issuer
co-signature. The issuer holds no contract function or admin/upgrade key to
move, freeze, or burn a right, and invalid or replayed proofs are rejected —
each shown by a public testnet transaction. Issuer co-signature is removed
whether verification and transfer fit in one transaction or are split into
two. Mainnet and security audit remain for Phase 3.

## Reference material

- Read stellar/stellar-dev-skill `skills/zk-proofs/SKILL.md` before Step 2 and
  follow its pitfalls and testing guidance. Where it conflicts with the SOW
  (for example, its suggestion of a separate verifier contract), the SOW wins:
  verification lives in the rights contract, behind `auth.rs`.
- The on-chain verifier starts from `stellar/soroban-examples/groth16_verifier`.

## Hard constraints (non-negotiable)

- Testnet only. No mainnet configuration, network switch, or mainnet key path.
- No custom cryptography. Use circom + circomlib templates, snarkjs Groth16
  (`-p bls12381`), and Stellar's native BLS12-381 host functions (CAP-0059).
  Build on the soroban-examples verifier; do not write one from scratch.
- Exactly one Circom circuit, as the SOW states. If commitment rotation or the
  link to the issuer-attested record seems to need a second circuit or a
  second proof, STOP and explain the trade-off instead of adding one.
- Poseidon over BLS12-381: circomlib's default Poseidon constants were
  generated for BN254, so compiling with `-p bls12381` alone is not enough.
  Generate constants only with the Poseidon authors' published reference
  tooling, using the same procedure that produced circomlib's defaults.
  Record the exact command, tool version, and parameters (t, R_F, R_P, alpha,
  field prime) in the circuit spec. If this cannot be done cleanly, STOP and
  tell me — do not switch curves on your own.
- The contract never computes Poseidon. Commitments and nullifiers arrive as
  public signals and are only compared and stored. Poseidon runs only inside
  the circuit and in the CLI prover.
- The verification key is fixed in the constructor at deploy time and stored
  in instance storage. No function takes a verification key as an argument,
  and no function can replace it after deployment.
- The proof check replaces the issuer-approval check inside
  `contracts/quietstay-rights/src/auth.rs`. Keep `auth.rs` the single
  authorization boundary.
- Remove the `upgrade` function. Add no function that lets the issuer move,
  freeze, burn, reassign, or overwrite a held right.
- The issuer only attests maintenance-fee status. That attestation is shown to
  the buyer and is never a precondition for a transfer, so withholding it
  cannot freeze a right.
- No personal data on the ledger. `npm run check-privacy` must keep passing,
  updated for the new events and storage.
- Never invent transaction hashes, contract addresses, or cost figures. Every
  number in the docs must come from a command you actually ran; record the
  command next to it.
- Trusted setup is a documented, builder-controlled development setup, labeled
  non-production everywhere it is mentioned. A production multi-party
  ceremony is Phase 3.

## Out of scope — do not build

Mainnet, security audit, production trusted setup ceremony, in-browser
proving, selective disclosure, new cryptographic primitives, swaps between
owners, payment and escrow, real resorts and legal title, passkey login.

## Work plan with checkpoints

| Step | SOW week | SOW deliverable |
| --- | --- | --- |
| 1–2 | Week 1 | Deliverable 1 |
| 3 | Week 2 | Deliverable 2 |
| 4 | Week 3 | Deliverable 2 evidence |
| 5–6 | Week 4 | Deliverable 3 |

### Step 1 — Circuit specification (Week 1 · STOP for my review)

Write `docs/CIRCUIT.md` before writing any circuit code.

Open it with a one-page plain-language summary — what the proof reveals, what
it hides, and what it prevents — for a reviewer with minimal technical
background. This page is the "one-page specification" evidence for
Deliverable 1. The detailed answers follow below it, and must address each
of these explicitly:

1. Exactly what the proof proves that `holder.require_auth()` alone does not.
   State the security benefit in one plain sentence.
2. The commitment formula: which record fields and which secret go into the
   Poseidon commitment, and how the record is encoded into field elements.
3. Commitment rotation after a sale: who generates the new secret, who
   computes the new commitment, how it reaches the contract, and why the
   previous owner's proof stops working. Also state what happens on a rental
   (I expect: no rotation, the term expires on its own as in Phase 1).
4. How the new commitment stays linked to the issuer-attested record, or, if
   it does not, state that plainly as a trust-model change.
5. Account binding: the 32-byte Stellar public key split into two field
   elements — byte order and split point.
6. Nullifier: derived from the record secret and the transfer context (right
   id, recipient, transfer mode, expiry ledger). Explain why these inputs are
   fixed by the transfer itself rather than chosen freely by the holder, why
   that makes a proof valid for one transfer only, why the holder can still
   prove again for the next rental or sale, and the maximum expiry window.
7. The full list of public inputs and private inputs, in the order the
   verifier receives them.
8. What the proof reveals and what it hides, as a two-column table.

Then stop and show me the spec. Do not proceed until I approve it.

### Step 2 — Circuit, setup, and cost measurement (Week 1 · STOP with numbers)

- `circuits/` folder: the circuit, circom tests (valid witness passes; wrong
  secret, wrong account, wrong nullifier inputs fail), and scripts.
- `scripts/setup-dev.sh`: reproducible development trusted setup on bls12-381
  producing the proving and verification keys. Commit the verification key,
  never toxic waste.
- `scripts/prove.*`: the command-line prover. It takes a record file, secret,
  account, and transfer context and writes a proof file plus public inputs.
  Run `snarkjs groth16 verify` on its output before anything goes on-chain.
- A conversion step from snarkjs JSON to the contract's types (G1 96 bytes,
  G2 192 bytes, Fr 32 bytes, uncompressed big-endian), following the
  soroban-examples test fixtures.
- Deploy the adapted standalone verifier to testnet and verify one real proof.
- Measure CPU instructions, memory, and fees: by simulation (`--send=no`)
  first, then confirm with one real transaction. Estimate the combined cost
  of verification plus transfer logic in one transaction.

Report: the first on-chain verification tx hash (Week 1 evidence), the
measured numbers, and your recommendation — one-transaction flow,
two-transaction flow, or the hashed-public-input fallback. Stop and wait for
my choice.

### Step 3 — Contract integration and first proof-gated transfers (Week 2)

In `contracts/quietstay-rights/`:

- Proof-gated rent and sell: holder signature + valid proof. The holder's
  signed arguments cover recipient and transfer mode, so the signature
  authorizes only that exact transfer. Issuer co-signature removed.
- Before calling the pairing check, validate every public signal against the
  contract's own state and the call arguments: the commitment equals the
  stored commitment for this right_id; the account halves equal the invoking
  holder's public key; right_id, recipient, mode, and expiry equal the call
  arguments; expiry is in the future and within the maximum window. Reject
  any mismatch before verification.
- Reject public signals that are not canonical field elements (>= the
  BLS12-381 scalar field modulus), so one nullifier cannot be stored under
  two encodings.
- Replay protection: store used nullifiers on-chain with appropriate TTL;
  reject any reused nullifier.
- Commitment rotation on sale, as defined in the approved spec, so the
  previous owner's proof no longer works.
- If the two-transaction flow was chosen: the first transaction verifies the
  proof and records a one-time authorization bound to holder, right,
  intended recipient, transfer mode, expiry, and nullifier, valid for a short
  ledger window; the second consumes exactly that authorization to complete
  the rental or sale. Both designs share the same rejection tests.
- Remove `upgrade`. Update `events.rs` so new events leak nothing.

Unit tests must cover, at minimum: valid rental, valid sale, tampered proof,
replayed proof, proof from the wrong account, proof for a different
recipient or mode, expired proof, expiry beyond the maximum window,
commitment mismatch, non-canonical public signal, transfer with issuer
authorization but no proof, issuer transferring a held right to itself, old
owner proving after a sale, renter attempting to sell, and fee attestation
absent but transfer still succeeding. Keep all still-relevant Phase 1 tests
passing.

**Checkpoint:** show me the test results and a summary of the contract
surface diff, then wait for my approval. After I approve, deploy the
integrated contract to testnet (verification key set in the constructor) and
produce one proof-authorized rental and one proof-authorized sale. Report
both tx hashes: they are the Week 2 evidence in the SOW.

### Step 4 — Inventory re-issue, redeploy, and rejection evidence (Week 3)

- Re-issue the sample inventory with Poseidon commitments, replacing Phase
  1's SHA-256 commitments. Update `inventory/` and `docs/COMMITMENT.md`, and
  state clearly that the Phase 1 `sha256sum` check no longer applies.
- Redeploy the contract to testnet with the verification key set in the
  constructor, and use this deployment for all final evidence.
- Produce paired evidence transactions on this deployment: an accepted
  rental, an accepted sale, and a rejected transaction for each case in the
  SOW — tampered proof, replayed proof, wrong-account proof, transfer
  attempted with issuer authorization but no proof, and the issuer
  transferring a held right to itself.
- Update `docs/EVIDENCE.md` in the Phase 1 style: each entry is a claim, a
  Stellar Expert (testnet) link, and one sentence on what to look for.
  Include where in Stellar Expert's function list to confirm there is no
  issuer function to move, freeze, or burn a right, no `upgrade` function,
  and no function that accepts a verification key.
- Update and run `npm run check-privacy` against the real chain to show no
  personal data appears on the ledger.

### Step 5 — Web app (Week 4)

- Add a "Prove ownership" step to the existing Transfer screen: the holder
  uploads the proof file from the CLI and completes a rental or sale.
- `/verify` shows the on-chain verification result and still works with no
  wallet and no account, so reviewers can repeat it.
- Keep it to the existing four screens. No new dashboards or admin views.
- Update `npm run e2e` to cover the proof flow, and redeploy the live app.

### Step 6 — Documentation and demo script (Week 4)

- `docs/DESIGN.md`: the new trust model, with a Phase 1 vs Phase 2
  issuer-powers table; the development trusted setup limitation; that
  removing `upgrade` means a bug fix requires a fresh deployment; and the one
  issuer power that remains — attesting falsely.
- `docs/CIRCUIT.md`: final version matching the code.
- `docs/SETUP.md`: circom, snarkjs, and Poseidon tooling versions and every
  new command.
- README.md: update the summary, the reviewer path, the test count, and
  "Out of scope" for Phase 2. Keep the Phase 1 tone: claims you can check.
- I will record the ~3 minute demo video myself. Leave me a short script
  listing each step to show — starting with generating a proof with the CLI,
  then using it for a rental and a sale, then the verify flow without a
  wallet — and the tx hash or screen that proves each one.

## How to work

- Small, focused commits with clear messages.
- When something in the SOW turns out to be impossible or ambiguous, stop and
  ask rather than choosing silently.
- At each checkpoint, give me: what was done, what was measured, what is
  still open, the exact commands to reproduce it, and the date it was
  completed, so the evidence lines up with the SOW timeline.
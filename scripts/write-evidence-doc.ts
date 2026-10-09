/**
 * Generate docs/EVIDENCE.md: Phase 2 from docs/evidence-phase2.json and
 * inventory/phase2/issued.json, then Phase 1 from docs/evidence.json and
 * inventory/issued.json.
 *
 *   npm run evidence-doc      (run automatically at the end of `npm run evidence`)
 *
 * Generated rather than hand-written, so a hash in the documentation cannot drift
 * from the hash on chain. Edit this script, not the Markdown.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";

import { NETWORK_PASSPHRASE, PHASE1_CONTRACT_ID as CONTRACT_ID, explorer } from "../src/lib/config";
import { fatal, log, readJson } from "./lib/cli";

const WASM_PATH = "contracts/target/wasm32v1-none/release/quietstay_rights.wasm";
const TEST_PATH = "contracts/quietstay-rights/src/test.rs";
const REPO = "https://github.com/murat48/QuietStay";

/**
 * Phase 1 as delivered. The contract source and tests on `main` are Phase 2's
 * now, so the Phase 1 section pins its links and figures to the last Phase 1
 * commit instead of reading the working tree.
 */
const PHASE1 = {
  commit: "a1b8ad2edf2953dac7216d36a49d2fb56c47b4b8",
  tests: 34,
  wasmBytes: 21_275,
};

/** Read facts rather than restate them, so the document cannot drift from the code. */
function contractFacts(): { tests: number; wasmBytes: number | null } {
  const tests = (readFileSync(TEST_PATH, "utf8").match(/^#\[test\]$/gm) ?? []).length;
  let wasmBytes: number | null = null;
  try {
    wasmBytes = statSync(WASM_PATH).size;
  } catch {
    // Not built in this checkout; the row is omitted rather than guessed.
  }
  return { tests, wasmBytes };
}

interface EvidenceFile {
  contract: string;
  accounts: { issuer: string; owner: string; renter: string; buyer: string };
  rights_issued_for_this_run: Record<string, { right_id: number; commitment: string; issue_tx: string }>;
  transactions: {
    id: string;
    title: string;
    what: string;
    expected: string;
    right_id: number;
    hash: string;
    successful: boolean;
    reached_ledger: boolean;
    failure?: string;
    explorer: string;
  }[];
}

interface IssuedFile {
  issuer: string;
  rights: {
    right_id: number;
    record_file: string;
    canonical_file: string;
    commitment: string;
    attestation_file: string;
    attested: boolean;
    issue_tx: string;
    week: { check_in: string; check_out: string; use_year: number };
    bedrooms: number;
  }[];
}

interface Phase2Evidence {
  generated_on: string;
  contract: string;
  deploy_tx: string;
  issuer: string;
  accounts: { owner: string; renter: string; buyer: string };
  holders_after: Record<string, string>;
  transactions: {
    id: string;
    title: string;
    claim: string;
    expected: string;
    look_for: string;
    right_id: number;
    signers: string[];
    hash: string;
    successful: boolean;
    op_result: string;
    error: string | null;
    fee_charged: number;
    declared_instructions?: number;
    explorer: string;
  }[];
}

interface Phase2Issued {
  rights: {
    right_id: number;
    record_file: string;
    week: { check_in: string; check_out: string };
    record_digest: string;
    commitment: string;
    issue_tx: string;
  }[];
}

/**
 * For a reader with no technical background: why the error is what it is, and
 * what that proves. Keyed by evidence id.
 */
const PLAIN: Record<string, string> = {
  "rejected-issuer-signed-no-proof":
    "In plain terms: this transfer carried both signatures that were enough in Phase 1 — " +
    "the owner's and the issuer's — but no proof, and the contract counted the proof's " +
    "values, found none, and refused it (WrongSignalCount means \"no proof attached\"). " +
    "So the issuer's signature does not stand in for the proof: without the proof, nothing moves.",
  "rejected-issuer-seizure":
    "In plain terms: the issuer tried to move someone else's week to itself, and the " +
    "contract's very first check — has the week's holder signed this? — said no " +
    "(Error(Auth, InvalidAction) means \"a required signature is missing\"). The issuer " +
    "cannot sign for the holder, so the issuer cannot take someone else's week.",
};

/** Contract error codes the Phase 2 evidence can show, by number. */
const ERROR_NAMES: Record<string, string> = {
  "Error(Contract, #16)": "WrongSignalCount",
  "Error(Contract, #21)": "WrongAccount",
  "Error(Contract, #27)": "NullifierUsed",
  "Error(Contract, #28)": "InvalidProof",
  "Error(Auth, InvalidAction)": "a required signature is missing",
};

/**
 * Earlier Phase 2 evidence, recorded in docs/CIRCUIT.md when it was produced and
 * kept here so the timeline is in one place.
 */
const PHASE2_EARLIER = {
  verifier: "CDMUMMOF3TM453RY4QZL6UWV2FT2QP3JUWW24SFIH5ICWSVGRB4IK5BK",
  firstVerification: "8e16b7cdfccd15cd475b5c2c0a58a72000546b8bbbf70068e87a1efe30c52645",
  week2Contract: "CBET7IDGZQKG2Q3KPUDNKWLFAVDJ2YQJTCKPIS5I55KTTDF7WIX45FC4",
  week2Rental: "85b16c610912f10812fd9fbcd30b7aabbccee325fd86b6e230fafd2861a55ce7",
  week2Sale: "9b7ce1ea45559b8e057a89c1aeaeb107e7abf6e72d3086ccaf373f786c13d974",
};

/** The functions the deployed Phase 2 contract exports, as `stellar contract info interface` lists them. */
const PHASE2_FUNCTIONS = [
  "__constructor", "balance", "burn", "commitment", "decimals", "get_listing", "get_right", "holder",
  "holding", "holdings", "is_active", "issue", "issuer", "list", "name", "next_id", "symbol",
  "transfer", "unlist",
];

function phase2Section(tests: number, wasmBytes: number | null): string {
  const ev: Phase2Evidence = readJson("docs/evidence-phase2.json");
  const inv: Phase2Issued = readJson("inventory/phase2/issued.json");
  const tx = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
  const contract = (c: string) => `https://stellar.expert/explorer/testnet/contract/${c}`;
  const short = (h: string) => `[\`${h.slice(0, 16)}…\`](${tx(h)})`;
  const accepted = ev.transactions.filter((t) => t.successful);
  const rejected = ev.transactions.filter((t) => !t.successful);
  // Who signed, by role: in these transactions the source account is whoever
  // initiates — the holder, unless the entry says otherwise.
  const role = (who: string) => {
    if (who === "source account") return "the holder (as source account)";
    if (who === ev.accounts.buyer) return `the buyer (\`${who.slice(0, 8)}…\`)`;
    if (who === ev.issuer) return `the issuer (\`${who.slice(0, 8)}…\`)`;
    return who;
  };
  const errorCell = (t: Phase2Evidence["transactions"][number]) =>
    t.error ? `\`${t.error}\` ${ERROR_NAMES[t.error] ?? ""}` : "—";

  return `## Phase 2 — proof-gated transfers

Transfers on this contract are authorized by a zero-knowledge proof verified on
chain — Groth16 over BLS12-381 — instead of the issuer's co-signature. The proof
is specified in [CIRCUIT.md](./CIRCUIT.md), which opens with a one-page summary.

### Phase 2, week by week

| Week | Evidence | Open |
| --- | --- | --- |
| 1 | One-page specification of the proof | [CIRCUIT.md — One page](./CIRCUIT.md#one-page-what-the-proof-does) |
| 1 | First on-chain verification of an ownership proof, by the standalone verifier [\`${PHASE2_EARLIER.verifier.slice(0, 8)}…\`](${contract(PHASE2_EARLIER.verifier)}) | ${short(PHASE2_EARLIER.firstVerification)} |
| 2 | Proof-authorized rental, on [\`${PHASE2_EARLIER.week2Contract.slice(0, 8)}…\`](${contract(PHASE2_EARLIER.week2Contract)}) | ${short(PHASE2_EARLIER.week2Rental)} |
| 2 | Proof-authorized sale, same contract | ${short(PHASE2_EARLIER.week2Sale)} |
| 3 | Inventory re-issued and the final deployment's two accepted and five rejected transfers | below |

### Phase 2: the contract

| | |
| --- | --- |
| **Contract** | [\`${ev.contract}\`](${contract(ev.contract)}) — testnet |
| **Deployed in** | ${short(ev.deploy_tx)} |
| **Verification key** | fixed in the constructor at deployment — [\`circuits/keys/verification_key.json\`](../circuits/keys/verification_key.json), from a **development trusted setup, non-production** |
| **Source** | [\`contracts/quietstay-rights/src/\`](../contracts/quietstay-rights/src/) — the proof check is in [\`auth.rs\`](../contracts/quietstay-rights/src/auth.rs) |
| **Tests** | ${tests} contract tests, every transfer carrying a real proof — \`cd contracts && cargo test\` |${
    wasmBytes === null ? "" : `\n| **WASM size** | ${wasmBytes.toLocaleString("en-US")} bytes |`
  }

**What the contract cannot do, and where to check it.** Its whole interface is
these ${PHASE2_FUNCTIONS.length} functions:

\`\`\`
${PHASE2_FUNCTIONS.join("  ")}
\`\`\`

- **No issuer function moves, freezes or burns a right.** The issuer's only entry
  point is \`issue\`, which writes to a fresh id. \`transfer\` and \`burn\` require the
  holder's own signature.
- **No \`upgrade\`.** The code deployed is the code that runs.
- **No function accepts a verification key.** \`verification_key\` is a parameter of
  \`__constructor\` alone.

To see the list yourself: on the contract's Stellar Expert page, the contract's
code (WASM hash \`25e95e05…\`) lists its exported functions — the same names as
above. From a terminal:
\`stellar contract info interface --id ${ev.contract} --network testnet\`.

### Phase 2: the seven transactions

All seven were included in a ledger; the five refusals are therefore evidence, not
assertions. Each refused transaction declared about twice the CPU its successful
twin needs, so it failed at the contract's check, not for lack of resources —
its result is \`invoke_host_function_trapped\` and its diagnostic events carry the
error below, both read back from the ledger.

| What | Outcome | Error on chain | Transaction |
| --- | --- | --- | --- |
${ev.transactions
  .map((t) => `| ${t.title} | ${t.successful ? "succeeded" : "**rejected**"} | ${errorCell(t)} | ${short(t.hash)} |`)
  .join("\n")}

${ev.transactions
  .map(
    (t) => `#### ${t.title}

${t.claim}

- Transaction: [\`${t.hash}\`](${t.explorer})
- Signed by: ${t.signers.map(role).join(", ")}${t.error ? `\n- Error on chain: \`${t.error}\` — ${ERROR_NAMES[t.error] ?? ""}` : ""}
- **Look for:** ${t.look_for}${PLAIN[t.id] ? `\n\n> ${PLAIN[t.id]}` : ""}`,
  )
  .join("\n\n")}

Where Stellar Expert shows a refusal: open the transaction; it is marked failed,
the operation's result is \`invoke_host_function_trapped\`, and the error sits in the
transaction's diagnostic events, which are part of the transaction meta the
explorer stores. ${rejected.length} refusals, ${accepted.length} successes; afterwards right #${
    accepted.find((t) => t.id === "sale")?.right_id
  } is held by the buyer, right #${accepted.find((t) => t.id === "rental")?.right_id} by the renter, and
the rights the refused transactions targeted are still the owner's.

### Phase 2: what the ledger shows

\`npm run check-privacy -- --phase2\` fetches all seven transactions and the four
issuances back from the network and searches the raw bytes of the envelope, the
result and the meta for every field of every record, every record's SHA-256
digest \`d\` (hex, raw, and as the circuit's two 16-byte halves), every owner's
secret \`s\` and every owner's secret hash \`h\`. None appears.

What is public, by design: account addresses, the right id, the Poseidon
commitment, the proof's three curve points and its eleven public signals (see
[CIRCUIT.md §8](./CIRCUIT.md#8-what-the-proof-reveals-and-what-it-hides)), a
rental's end time, and on a sale the buyer's next secret hash \`h'\` — which
proves nothing without the record and the buyer's secret.

### Phase 2: the sample inventory

The four sample weeks, re-issued on this contract with Poseidon commitments
\`C = Poseidon(d, owner, h)\`. The records are the Phase 1 records, unchanged, so
each \`d\` is still what \`sha256sum\` gives for the record's canonical form —
see [COMMITMENT.md](./COMMITMENT.md).

| Right | Week | \`d\` (SHA-256 of the record) | Commitment \`C\` on chain | Issued in |
| --- | --- | --- | --- | --- |
${inv.rights
  .map(
    (r) =>
      `| #${r.right_id} | ${r.week.check_in} → ${r.week.check_out} | \`${r.record_digest.slice(0, 16)}…\` | \`${r.commitment.slice(0, 16)}…\` | ${short(r.issue_tx)} |`,
  )
  .join("\n")}

Reproduce: \`npm run zk:reissue -- <contract>\` then
\`npm run zk:evidence -- <contract> <deploy tx>\`. Both need the testnet keys in
\`.env.local\`; the record secrets they create stay in \`.secrets/\`, outside git.
`;
}

function main(): void {
  const evidence: EvidenceFile = readJson("docs/evidence.json");
  const issued: IssuedFile = readJson("inventory/issued.json");

  const byId = (id: string) => evidence.transactions.find((t) => t.id === id);
  const rental = byId("rental");
  const sale = byId("sale");
  const noApproval = byId("rejected-no-approval");
  const seizure = byId("rejected-seizure");

  const { tests: phase2Tests, wasmBytes: phase2WasmBytes } = contractFacts();
  const { tests, wasmBytes } = PHASE1;

  const txRow = (item: EvidenceFile["transactions"][number] | undefined): string => {
    if (!item) return "| _(not produced)_ | | | |";
    const verdict = item.successful ? "succeeded" : "**rejected by the contract**";
    return `| ${item.title} | ${verdict} | [\`${item.hash.slice(0, 16)}…\`](${item.explorer}) | ${
      item.reached_ledger ? "yes" : "**no**"
    } |`;
  };

  const doc = `# Evidence

Everything a reviewer needs, as links to open. No cloning, no building, no command
line. Generated by \`npm run evidence\` — the hashes below came back from the network,
they were not typed in.

**Phase 2 — proof-gated transfers**

- [Week by week](#phase-2-week-by-week)
- [The contract, and what it cannot do](#phase-2-the-contract)
- [The seven transactions](#phase-2-the-seven-transactions)
- [What the ledger shows](#phase-2-what-the-ledger-shows)
- [The sample inventory](#phase-2-the-sample-inventory)

**Phase 1 — issuer-approved transfers** (delivered; links pinned to the last Phase 1 commit)

- [What is deliberately not here](#what-is-deliberately-not-here)
- [Deliverable 1 — the contract](#deliverable-1--soroban-smart-contracts)
- [Deliverable 2 — verification and selective disclosure](#deliverable-2--verifiable-ownership-and-selective-disclosure)
- [Deliverable 3 — the reference application](#deliverable-3--reference-web-application)
- [Reproducing all of it](#reproducing-all-of-it)

---

${phase2Section(phase2Tests, phase2WasmBytes)}
---

# Phase 1

## What is deliberately not here

Phase 1 verifies ownership from **existing Stellar building blocks, with no custom
cryptography** — SHA-256 through WebCrypto, Ed25519 through the same
\`Keypair.sign\`/\`verify\` that signs every Stellar transaction, SEP-41 for the token
interface, SEP-10 for authentication, and the SEP-8 approval model for
issuer-controlled transfer. Nothing cryptographic was written for this project.

In particular, **there is no zero-knowledge proof generation or on-chain
verification here, and there is not meant to be.** The SOW lists it under
*Out-of-Scope (Explicitly Not Included)*, alongside mainnet deployment, a security
audit, any custom cryptographic implementation, legal title transfer, integration
with real resorts, swaps and multi-party exchange, and payment, escrow or
settlement of consideration. None of the eight appears in this repository.

A grep for \`groth16\`, \`bls12\`, \`bn254\` or \`poseidon\` does return two matches, and
both are in \`contracts/Cargo.lock\`: \`soroban-sdk\` carries the BLS12-381 and BN254
curve libraries because the host exposes those functions, and nothing here calls
them. Worth stating rather than glossing, because it says something useful about
the next phase — the primitives a proof would need are already on the network.
CAP-0059 is Final at protocol 22, CAP-0074 and CAP-0075 at protocol 25, and
testnet runs 28. What stands between this phase and a verified proof is the work,
not the platform.

The SOW mentions zero-knowledge proofs three times and all three are negations: the
out-of-scope list, \`no custom cryptography\` in Deliverable 2, and the sentence that
Phase 1 *"rests on a trusted issuer signature rather than on a cryptographic proof;
reducing that reliance is an objective for a later phase."* That last one is the
whole boundary of this phase, stated up front rather than discovered: what a
verifier proves here is that the **issuer said** something, not that it was honest.
Moving that line is what Phase 2 is for, and
[DESIGN.md](./DESIGN.md#what-phase-2-is-for) says what it would take.

The one condition that does bear on Phase 1 — that issuer-approved transfers must
not let the issuer unilaterally seize or freeze a right — is enforced by the
contract rather than by good behaviour, and
[demonstrated on chain below](#the-centralization-condition).

---

## Deliverable 1 — Soroban smart contracts

| | |
| --- | --- |
| **Network** | \`${NETWORK_PASSPHRASE}\` (testnet) |
| **Contract address** | [\`${CONTRACT_ID}\`](${explorer.contract(CONTRACT_ID)}) |
| **Explorer** | ${explorer.contract(CONTRACT_ID)} |
| **Source** | [\`contracts/quietstay-rights/src/\`](${REPO}/tree/${PHASE1.commit}/contracts/quietstay-rights/src) at the last Phase 1 commit |
| **Tests** | [\`src/test.rs\`](${REPO}/blob/${PHASE1.commit}/contracts/quietstay-rights/src/test.rs) — ${tests} tests, \`git checkout ${PHASE1.commit.slice(0, 7)} && cd contracts && cargo test\` |${
    wasmBytes === null
      ? ""
      : `\n| **WASM size** | ${wasmBytes.toLocaleString("en-US")} bytes (limit 65,536) |`
  }

The transfer design is one primitive with a duration parameter: an open-ended
transfer is a sale, a transfer carrying an expiry is a rental, and there is no
second code path. See [DESIGN.md](./DESIGN.md#the-transfer-primitive).

Tests that matter most, by name:

| Test | What it pins down |
| --- | --- |
| \`a_rental_lapses_with_no_return_transaction\` | A term ends on its own; nobody sends anything. |
| \`a_lapsed_renter_cannot_transfer_the_week_on\` | A renter whose term ended is not the holder and is rejected. |
| \`a_lapsed_renter_cannot_list_or_burn_the_week\` | The same, for every other action. |
| \`a_transfer_needs_both_the_holder_and_the_issuer\` | Holder alone fails; issuer alone fails; both succeed. |
| \`the_issuer_cannot_seize_a_held_right\` | The centralization condition, in a unit test. |
| \`the_issuer_cannot_seize_a_right_that_is_out_on_rental\` | Neither title nor occupancy is reachable. |
| \`the_issuer_cannot_burn_a_holders_right\` | No destruction path for the issuer either. |
| \`an_approval_is_bound_to_the_exact_terms_it_was_given_for\` | An approval cannot be redirected to another recipient or term. |
| \`a_renter_cannot_sell_what_they_only_rent\` | No grant may outlast the grantor's own term. |
| \`the_title_holder_cannot_sell_over_an_active_rental\` | A renter cannot be sold out from under. |

## Deliverable 2 — Verifiable ownership and selective disclosure

### The four transactions

Two succeed, two are refused. All four were included in a ledger, which is what makes
the refusals evidence rather than assertions — a transaction the network turns away at
submission leaves nothing to open.

| What | Outcome | Transaction | On ledger |
| --- | --- | --- | --- |
${txRow(rental)}
${txRow(sale)}
${txRow(noApproval)}
${txRow(seizure)}

**The two required hashes**, stated plainly:

- Transfer **with** issuer approval, succeeds: [\`${sale?.hash ?? "—"}\`](${sale?.explorer ?? ""})
- Transfer **without** issuer approval, rejected by the contract: [\`${noApproval?.hash ?? "—"}\`](${noApproval?.explorer ?? ""})

Both are the same transfer of the same right by the same holder. The only difference
is the issuer's authorization entry. ${
    noApproval?.failure ? `The contract's refusal: _${noApproval.failure}_` : ""
  }

### The centralization condition

The reviewer's condition on approval was that issuer-approved transfers must not let
the issuer seize or freeze anything. This transaction is the issuer attempting exactly
that — building, signing, and paying for a transfer of a held right to itself:

**[\`${seizure?.hash ?? "—"}\`](${seizure?.explorer ?? ""})** — rejected by the contract.

The issuer can supply its own approval; it cannot supply the holder's authorization,
which \`transfer\` requires independently. See
[DESIGN.md § centralization](./DESIGN.md#centralization-what-the-issuer-can-and-cannot-do)
for the enumerated privileged surface and an honest account of what a malicious issuer
can still do.

### What the explorer shows

Verified by fetching each transaction back from the network and searching the raw
bytes of the envelope, the result, and the meta for every value in the off-chain
records — \`npm run check-privacy\`. Nothing was assumed.

**Never present:** owner name, email, resort name, country, unit, deed reference,
registry, record id, salt, or any fee figure.

The successful **sale** transaction's contract call, decoded in full:

\`\`\`
transfer(
  from       = "${evidence.accounts.owner}"
  to         = "${evidence.accounts.buyer}"
  right_id   = ${sale?.right_id ?? "—"}
  expires_at = null        // a sale carries no timestamp at all
)
\`\`\`

and its event: topics \`["transfer", <from>, <to>]\`, data
\`{ commitment: 0x…, expires_at: null, right_id: … }\`.

A hash and account addresses. That is the whole of it.

Two things *are* public, deliberately, and are documented rather than glossed over:
the week's date range lives in contract state because an offer has to say what it is
offering, and a rental's term-end timestamp is in the call because the contract cannot
enforce a term it cannot see. Neither is attached to any identity. Full accounting in
[DESIGN.md § what the ledger reveals](./DESIGN.md#what-the-ledger-reveals).

### A sample attestation

[\`inventory/attestations/right-1.attestation.json\`](../inventory/attestations/right-1.attestation.json)
— issuer-signed, bound to right #1, this contract, and this network. Schema, signing
input, and the eleven-step verification procedure are in
[ATTESTATION.md](./ATTESTATION.md).

Also included on purpose: [\`right-4.attestation.json\`](../inventory/attestations/right-4.attestation.json),
which asserts \`maintenance_fees_current: false\`. Sample week 04 carries €410 in
arrears, so the issuer attests that it is **not** clean. Verifying right #4 fails on
exactly that check, and the approval service declines to approve a transfer of it —
while the holder keeps the week, because declining is not seizing.

### Sample inventory

| Right | Week | Attested clean | Commitment | Record |
| --- | --- | --- | --- | --- |
${issued.rights
  .map(
    (r) =>
      `| #${r.right_id} | ${r.week.check_in} → ${r.week.check_out} | ${
        r.attested ? "yes" : "**no — arrears**"
      } | \`${r.commitment.slice(0, 16)}…\` | [\`${r.record_file.split("/").pop()}\`](../${r.record_file}) |`,
  )
  .join("\n")}

Each commitment is reproducible with \`sha256sum\` alone —
see [COMMITMENT.md](./COMMITMENT.md#reproducing-a-commitment).

### One week in the registry has no attestation, and cannot be given one

Right **#36** exists on chain, carries the commitment
\`7634048ef3230aec…\`, and has no attestation. The registry shows it as never
attested, which keeps it out of every shopping filter, and \`approve-transfer\`
would decline it, so nobody can take it. It is listed here rather than quietly
left to be discovered.

It was issued from the deployed app at a moment when that deployment had the
issuer key but nowhere to write. The transaction went to the ledger and the
attestation had no destination — the ordering bug is described in
[VERCEL.md](./VERCEL.md#issuing-checks-the-store-before-it-touches-the-chain),
and \`/api/issue\` now checks it can write before it touches the chain.

It cannot be repaired, and the reason is the point. Every record carries a
32-byte random \`salt\`, and that record was never persisted — being unable to
persist it *was* the failure. Producing a record that hashes to
\`7634048ef3230aec…\` therefore means recovering 256 bits of randomness that
exist nowhere. The issuer holds the signing key, controls the deployment, and
still cannot backfill a record to match a commitment it published. That is the
binding property this document argues for, demonstrated at our own expense.

## Deliverable 3 — Reference web application

Four screens, connected to the deployed contract:

| Screen | What it does |
| --- | --- |
| [Issue](../src/app/issue/page.tsx) | Commit to an ownership record and create the right. The commitment is computed in the browser, so the hash is never a surprise from a server. |
| [List](../src/app/list/page.tsx) | The registry as the contract has it: holder, term, standing offers. |
| [Verify](../src/app/verify/page.tsx) | A counterparty checks a disclosed record and attestation, entirely client-side. |
| [Transfer](../src/app/transfer/page.tsx) | Rent or sell through one form, with issuer approval — plus a control that submits **without** approval so the refusal can be watched. |

Live at **[quietstay.vercel.app](https://quietstay.vercel.app)**, on testnet.
Verifying needs no account and no wallet — enter a right id on the verify screen,
\`3\` for instance, and every check runs in your own browser against the deployed
contract. The registry screen asks for a signed-in wallet, which is a product
decision and not a boundary: \`/api/inventory\` answers anyone, and so does the
contract.

**[Demo video, ~3 min](https://youtu.be/7hhtiG_yGFY)** — a week issued and
offered, a counterparty verifying it, a week in arrears failing exactly one
check, a rental and a sale, and the same transfer refused when the issuer's
approval is taken out of it.

That deployment holds the issuer key, so weeks can be issued from it directly.
[VERCEL.md](./VERCEL.md) documents both that and the alternative — a public
deployment with no key at all, which still browses, verifies, signs in and
publishes offers, because none of those need one. The distinction is worth
knowing: the key signs every attestation and authorizes every transfer, and
because the contract fixed its issuer at construction it cannot be rotated, so a
key that leaks is leaked for the life of the deployment.

What it cannot do is the claim this whole document exists to support: even a host
compromised completely could not **take** a week. \`transfer\` begins with
\`from.require_auth()\`, which no server-side key satisfies — only the holder's
wallet does. The worst a stolen issuer key can do is lie.

Locally: [SETUP.md](./SETUP.md).

End-to-end test against the running app — SEP-10, issuance, offers, an approved
rental, a refused unapproved transfer, a declined approval, and an attempted
impersonation:

\`\`\`
npm run build && npm run start     # one terminal
npm run e2e                        # another → end-to-end checks
\`\`\`

## Accounts used

| Role | Account |
| --- | --- |
| Issuer | [\`${evidence.accounts.issuer}\`](${explorer.account(evidence.accounts.issuer)}) |
| Owner | [\`${evidence.accounts.owner}\`](${explorer.account(evidence.accounts.owner)}) |
| Renter | [\`${evidence.accounts.renter}\`](${explorer.account(evidence.accounts.renter)}) |
| Buyer | [\`${evidence.accounts.buyer}\`](${explorer.account(evidence.accounts.buyer)}) |

### Why the renter's account is mostly failed transactions

Open that account and most of what is there was rejected. That is the test suite, not
a broken build, and it is worth saying exactly what produces it.

Step 6 of \`npm run e2e\` rebuilds the rental transfer with the issuer's authorization
entry stripped out and submits it from the renter's account. The contract refuses it.
The check is that the refusal happened **and** that the week did not move. Every run of
the suite leaves one more refusal on the ledger, and the suite is run often.

Decode their result codes and they are one thing, without exception:

\`\`\`
txFailed / invokeHostFunctionTrapped
\`\`\`

Not one is a malformed transaction, an underfunded account, a bad sequence number, or a
bug. Every one is the contract enforcing the rule this project exists to demonstrate.
Count them yourself — Horizon hides failed transactions unless asked for them:

\`\`\`bash
curl -s "https://horizon-testnet.stellar.org/accounts/${evidence.accounts.renter}/transactions?limit=200&include_failed=true"
\`\`\`

The suite could submit that step only behind a flag and keep the account tidy. It does
not, because the check would then be absent from the default run, and a green
\"all checks passed\" that never actually asked the chain is the kind of assurance this
repository is arguing against.

## Reproducing all of it

\`\`\`bash
git checkout a1b8ad2 && (cd contracts && cargo test)   # Phase 1's 34 unit tests
./scripts/deploy.sh                 # build, test, deploy to testnet
npm run seed                        # issue the sample inventory, write attestations
npm run evidence                    # produce the four transactions above
npm run check-privacy               # confirm nothing leaked, against the real chain
npm run verify-record -- 3 inventory/records/week-03.json inventory/attestations/right-3.attestation.json
\`\`\`

\`npm run evidence\` issues its own weeks each time rather than reusing the sample
inventory, because a sale is permanent and reusing them would make the script work
exactly once. Re-running it appends rights to the registry and rewrites this document.

---

_Generated ${"by `npm run evidence`"} from \`docs/evidence.json\`. Do not edit by hand._
`;

  writeFileSync("docs/EVIDENCE.md", doc, "utf8");
  log.ok("wrote docs/EVIDENCE.md");
}

try {
  main();
} catch (error) {
  fatal(error);
}

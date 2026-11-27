# QuietStay Phase 3 — specification

Status: **approved (2026-11-19, third review).** D1–D12 and D4a are all
approved, some with the changes recorded here. Step 2 starts in a new
session.

Written 2026-11-19 against `main` at `66cdf13`. Every measured number below
names the command that produced it. Anything marked *estimate* is derived from
measured numbers, and the derivation is shown.

---

## One page, in plain language

**What QuietStay is today.** A vacation week is a token on Stellar. To rent it
out or sell it, the owner needs two things: their wallet, and a secret that only
the owner knows. The owner proves they know the secret with a small mathematical
proof, and the contract checks that proof. Nobody else, not even the company
that issued the week, can move it. Today the owner makes the secret and the
proof with command-line tools. Nobody pays anyone: the contract moves weeks,
not money.

**What Phase 3 adds.**

1. **No command line.** The website makes the secret and the proof itself,
   inside the owner's browser. The secret and the ownership record never leave
   that browser; an automated test watches every network request to prove it.
2. **Passkeys.** Instead of a wallet extension, a user can approve with a
   passkey (Face ID, fingerprint or device PIN). Behind the passkey is a
   "smart wallet", a small contract account. The existing wallets keep working.
3. **Paying in USDC, safely.**
   - *Sale:* the buyer makes an on-chain offer and lets the contract take up to
     the price from their account. Nothing moves until the owner accepts. When
     the owner accepts, the money goes to the owner and the week goes to the
     buyer in **one** transaction. Either both happen or neither does.
   - *Rental:* when the owner accepts, the renter's money goes into the
     contract (an *escrow*), not to the owner. The owner can collect it only
     **24 hours after check-in**. Until then the renter can release it early, or
     report a problem. (The contract allows an early release at any time; the
     app offers it only from check-in, with a confirmation, so that nobody can
     talk a renter into paying before seeing the stay. Decided 2026-11-25.) A reported problem is settled by the two parties or,
     failing that, by a fixed *arbiter* address. The arbiter can only send the
     escrowed money to the owner or back to the renter. It cannot touch any week.
4. **Swaps.** Two owners can exchange weeks. Both weeks move in one transaction,
   or neither does.
5. **A small live pilot on Stellar Mainnet**, with sample weeks and at most
   1 USDC per payment (5 USDC in total), all in the builder's own accounts. It
   starts only after a written checklist and your GO.

**What does not change.** One proof circuit, the same cryptography, the same
verification key, and in the rights contract no admin key and no upgrade
function. (The reused SEP-45 web-auth contract, for passkey sign-in, has an
`upgrade` that nobody can ever authorize; see §10.) The trusted setup is
still the builder's development setup and is labeled non-production
everywhere. This is a controlled pilot, not an audited launch.

**Review status (2026-11-19).** The circuit does **not** need to change
(item 1), and a smart-wallet proof has been made and verified to show it.
Every decision is approved, some with changes this version records. That
includes D4a, the order of record delivery and offers. See
[Decisions for approval](#decisions).

---

## Step 0 findings that shape this spec

- **No Phase 3 code exists.** The only Phase 3 material is
  `docs/PHASE3_PROMPT.md` and `docs/PHASE3_PROGRESS.md`, plus the one-off
  measurement contract added for item 11 (`contracts/quietstay-measure`, not
  product code). The two side branches, `feat/premium-marketplace-ui` and
  `phase1-upgrade-and-fee-settlement`, hold UI and Phase 1 work only.
- **The circuit has 11 public signals:** `commitment, nullifier, right_id,
  from_hi, from_lo, to_hi, to_lo, mode, expiry_ledger, next_secret_hash,
  next_commitment` (`circuits/gpl/transfer.circom`, docs/CIRCUIT.md §7).
- **How the holder's account is bound today.** `C = Poseidon5(d_hi, d_lo,
  from_hi, from_lo, h)`, where `(from_hi, from_lo)` are the two 16-byte halves
  of the holder's 32-byte Ed25519 key. `auth.rs::split_account` takes the key
  from `Address::to_payload()` and refuses anything but a `G…` account
  (`NotAnAccount`, error 18). `issue` refuses a contract address as owner for
  the same reason. A C-address cannot hold a right today.

---

## 1. Account binding for passkeys (blocking)

**The problem.** A smart wallet is a contract address (`C…`). The Phase 2 proof
binds 32 bytes of the holder's Ed25519 key, and a contract address has no such
key.

**Design: bind the 32-byte payload of either address kind, with a kind tag in
the high half. No circuit change.**

`Address::to_payload()` returns 32 bytes for both kinds:

| Address | Payload | Tag `t` |
| --- | --- | --- |
| `G…` account | `AccountIdPublicKeyEd25519(k)`, the Ed25519 key | `0` |
| `C…` contract (smart wallet) | `ContractIdHash(k)`, the contract id | `1` |

```
hi = t · 2^128 + int(k[0..16], big-endian)
lo =             int(k[16..32], big-endian)
```

- **For `G…` accounts nothing changes** (`t = 0`). Every Phase 2 commitment,
  proof, fixture and test stays valid.
- **The circuit already accepts this.** `from_hi`, `from_lo`, `to_hi` and
  `to_lo` are plain field elements (BLS12-381 `r` is about 2^255), and the
  circuit hashes them without range checks. A value up to 2^129 is a valid
  input. So the circuit, the proving key and the verification key all stay
  unchanged.
- **Kinds cannot be confused.** Without the tag, a `G…` key and a `C…` id with
  the same 32 bytes would encode the same way. Making that happen would already
  require a SHA-256 preimage or an Ed25519 key for a chosen value. With the tag,
  the encodings are disjoint by construction, so no argument about hardness is
  needed.
- **The contract still never computes Poseidon.** `auth.rs` builds `(hi, lo)`
  from the `Address` it was given, then compares them with the signals.
- **Who authorizes stays separate from what is proved.** For a smart wallet,
  `from.require_auth()` invokes the wallet's `__check_auth`, which checks the
  passkey signature via the OpenZeppelin WebAuthn verifier. The proof still
  says "this address's record secret is known". A transfer from a smart wallet
  therefore needs the passkey **and** the secret, just as a `G…` holder needs
  the wallet key **and** the secret.

Code changes, for after approval:

- `split_account` becomes `split_address`, and it adds `2^128` to `hi` for a
  contract.
- `require_account` accepts both kinds and still rejects anything else.
- `issue` accepts a `C…` owner.
- The prover's `split` (`scripts/lib/zk-encode.ts`) and its browser version
  apply the same tag. docs/CIRCUIT.md §5 is updated.
- New tests: a proof from a C-address holder, a proof to a C-address
  recipient, a G-key/C-id collision (same 32 bytes, different kind) that must
  be rejected, and every Phase 2 test unchanged.

**Review condition (D1), checked 2026-11-19.**

- **No range check exists on the account halves.**
  - `transfer.circom` instantiates only `Poseidon(1)`, `Poseidon(5)` and
    `Poseidon(6)`.
  - `poseidon.circom` builds those from the round-constant, S-box and mix
    templates only.
  - Neither file contains `Num2Bits`, a comparator or any other bit
    decomposition (`grep -nE "Num2Bits|LessThan|GreaterThan|Bits"
    circuits/gpl/*.circom`).
  - `from_hi`, `from_lo`, `to_hi` and `to_lo` are used only as Poseidon inputs.
- **Proved and verified end to end for a C-address holder** with the committed
  `transfer.wasm`, `transfer.zkey` and `verification_key.json`, unchanged. The
  test is `circuits/test/c-address.test.ts`, run with `npm run zk:test`; 18/18
  pass, including the 11 Phase 2 tests. It covers:
  - a sale from a C holder to a G account;
  - a sale from a G account to a C recipient;
  - a rental from a C holder;
  - the same 32 bytes as G and as C give different encodings and commitments;
  - a witness claiming the untagged encoding of a C holder's commitment fails
    at the circuit's commitment constraint (`transfer.circom` line 50).
- **The C-holder proof also verifies on chain.** The Phase 2 verifier
  `CDMUMMOF3TM453RY4QZL6UWV2FT2QP3JUWW24SFIH5ICWSVGRB4IK5BK` returns `true`;
  with one public signal changed it returns `false`. Commands:
  - `QS_WRITE_PROOF_DIR=proofs/phase3-c-address npx tsx --test circuits/test/c-address.test.ts`
  - `stellar contract invoke --id CDMUMM…K5BK --network testnet --send=no -- verify --proof "$(cat proofs/phase3-c-address/proof.json)" --public_signals "$(cat proofs/phase3-c-address/public.json)"`
- **No circuit change is needed.** The contract-level test (a C-address holder
  transferring through `authorize_transfer` with a real passkey-signed auth
  entry) is part of Step 2, because it needs the `auth.rs` change.

**Honest limit.** In the browser, the passkey and the record secret live on the
same device. A stolen *unlocked device* gives both. Phase 2's "a stolen wallet
key alone cannot transfer" still holds for a stolen *passkey* (a passkey cannot
be exported) and for a stolen G-key.

## 2. Browser proving

**Where things are kept.** The data lives in IndexedDB, in the app's own
origin. Records are keyed by `(network, contract id, right id)`:

| Entry | Contents | Created |
| --- | --- | --- |
| `secret` | `s` (32 random bytes from `crypto.getRandomValues`, reduced below `r`), `h` | when the user asks for a week, or when a buyer makes an offer |
| `record` | the canonical ownership record (JSON) and its digest `d` | imported once (below) |
| `pending` | for a buyer: `s'`, `h'`, the offer id | when the offer is made; becomes `secret` once the chain shows the buyer holding title with the matching commitment |

The secret is stored as-is. Encrypting it at rest with a key derived from the
passkey (WebAuthn PRF) would be scope creep, and it would not protect against
the same-device case anyway. A backup export is decision D3.

**How they get there the first time, for a sample right.** Phase 3 deploys a
new contract, so the sample weeks are issued again:

1. The owner opens *Request a week*. The prover worker generates `s` and
   computes `h = Poseidon(s)`. The request sends only `h`, exactly as the
   Phase 2 `/issue?h=…` flow does.
2. The issuer issues as in Phase 2. The server computes `C` from the record
   and `h`, and it never sees `s`.
3. The record reaches the owner's browser through the **sealed link**
   described below. The owner's request link goes to the issuer, and the
   issuer's browser sends back the encrypted record. The worker computes `d`
   and `C = Poseidon(d, owner, h)` and refuses the record unless `C` equals
   the commitment on chain. This is decision D3; no file is involved.

From then on, proving needs no file and no command line.

**A buyer's new secret, after a sale or a swap.**

1. The buyer has already received the record through the sealed link below,
   and checked it against the current on-chain `C` with the seller's `h`,
   **before creating an offer** (D4 change 1). That is the Phase 2
   verification step, now in the browser. The record is kept.
2. When making the offer, the buyer's worker generates `s'` and stores it as
   `pending` **before** the offer transaction is signed. The offer carries `h'`
   and the hash of the buyer's record key.
3. When the chain shows the buyer holding title and
   `commitment == Poseidon(d, buyer, h')`, the `pending` entry becomes the
   buyer's `secret`.

A swap works the same way for both sides.

**How the buyer's browser receives the private record: a sealed link, with no
files and no server storage (D4, approved with changes).** The buyer needs `d`
to prove later, and wants the whole record to check what they are buying. Two
browser-made links carry it. Each link carries its data only after `#`.
Browsers never send the part after `#` in any HTTP request, so the server
neither receives nor stores it.

**The order prevents a seller from taking payment and then withholding the
record.** The record is received and checked before the buyer makes any offer,
so before any money can move. The key it is sealed to is bound on chain to the
buyer's account first (D4 change 2; D4a, approved: the binding sits in a
*record request* that precedes the offer):

1. **Record request, on chain.** The buyer presses *Ask for the record*. Their
   browser makes an ECDH P-256 key pair with WebCrypto. The private key is
   non-extractable and kept in IndexedDB. Then the buyer signs
   `request_record(buyer, right_id, key_hash)`, where
   `key_hash = SHA-256(buyer's raw public key)`. This stores a temporary
   `RecordRequest` entry (≤ D9 lifetime). It moves nothing and costs only a
   fee.
2. **Request link.** The browser shows
   `…/receive#req=<request id>.<buyer public key>`, which the buyer sends to the
   seller through any channel the two already use (a message, an email).
3. **The seller's browser checks the key, then encrypts.** It reads
   `RecordRequest(id)` from chain and **refuses unless
   `SHA-256(link key) == key_hash`**, and unless the request is for a right
   this seller holds. Then it shows the requesting account to the seller for
   confirmation. Only then does it encrypt
   `{record, h, right id, contract id, request id}` to that key (ECDH with an
   ephemeral seller key, then HKDF-SHA-256, then AES-256-GCM), and show
   `…/receive#rec=<ciphertext>`. The record is about 900 bytes, so the link is
   about 1.5 KB.
4. **Import.** The buyer opens the reply link. The app does the following
   before anything else:
   - reads the fragment and removes it from the address bar
     (`history.replaceState`);
   - decrypts it;
   - computes `d` and `C = Poseidon(d, seller, h)` in the worker;
   - keeps the record only if `C` equals the commitment on chain now.

   Only after that does the app let the buyer create the offer.
   `create_sale_offer` takes the request id. It requires the request to be the
   buyer's own, for the same right, and copies its `key_hash` into the offer.
   The offer therefore states which key the record was sealed to.
5. **After the sale**, nothing more has to travel. The buyer's browser already
   holds the record and checks the new commitment against `s'`.

**Swaps use the same pattern on both sides.**

This holds in both directions (D4a addition 1):

- Each side signs `request_record` for the other's right. The maker requests
  `want_right` and the taker requests `give_right`.
- Each side's browser checks the requester's link key against the on-chain
  `key_hash` before sealing its own record.
- **A swap can be completed only after both sides have checked the other's
  record:**
  - `offer_swap` requires the maker's live request for `want_right`;
  - `accept_swap` requires the taker's live request for `give_right`;
  - `complete_swap` requires the acceptance, so both requests existed.
  - The app signs `accept_swap` only after the taker's browser has checked the
    maker's record against the current commitment. It signs `complete_swap`
    only after the maker's browser has checked the taker's record. Each side's
    own signature is therefore its confirmation.
- The contract enforces that both key bindings exist. It cannot see a browser
  check. What it guarantees is that neither right can move unless both sides
  bound a key on chain and then signed the step that follows.
- **Rentals do not use requests.** A renter never proves, so needs no record.

**The first owner (D3)** uses the same pattern. The owner's issuance ask
already carries `h`, and now it also carries `key_hash`. The issuer's browser
checks it before sealing the record. The ask lives in the existing off-chain
request store and holds no record data.

**One link instead of two, for the first owner (Step 5, approved 2026-11-25).**
Testing on the testnet demo showed the two-link round trip was where owners
got lost. Since then:

- The ask also carries the owner's raw **public key** (`public_key`). The
  server accepts it only if its SHA-256 is the ask's `key_hash`.
- When the issuer issues from the ask, the issuer's browser seals the record
  at once and shows the **reply link**. No request link has to travel. The
  request link remains as a fallback, for an issuer who lost the reply link.
- **The issuer's `/issue` screen issues only from an owner's ask.** Weeks #9
  to #11 on the demo contract were issued with a typed-in owner, so no browser
  held their secrets and they can never be proven for. Issuing with a
  typed-in `h` remains a command-line path (`npm run zk:issue`), for an owner
  who keeps their own secret file.
- **What this does not change:**
  - The record and the secret still never travel in a request from the
    owner's browser.
  - The reply link still travels only after `#`.
  - Only the owner's browser can open the reply link.
- **What the server now learns, and why it gains nothing:**
  - The server learns the owner's public key, which is public by nature.
  - It already sees the record at issuance, because `/api/issue` computes `d`
    and `C`. So a server that swapped in its own key would gain nothing it
    did not already have.
- **No change for buyers and swaps.** Their request links still carry the
  key, which is bound on chain by `request_record`. For them the server never
  sees the record.
- The no-leak test (e2e/no-leak.spec.ts) allows an owner's public key in
  exactly one request, the ask itself, and fails if it appears in any other.

**No link at all, for the first owner: the issuance inbox (D3 amended,
approved 2026-11-25).** Even one link proved too much in practice. The owner
had to copy a long link from the issuer's screen into their own browser
before they could rent the week out. You decided to amend D3 for issuance
only:

- **What changes.** After sealing, the issuer's browser leaves the sealed
  record with the owner's ask (`POST /api/requests/issuance/delivery`).
  - When the owner is signed in, their browser picks it up
    (`src/components/SealedInbox.tsx`). This happens on sign-in, on each page
    and when the tab comes back into view.
  - The browser opens it, checks it against the commitment on chain exactly
    as `/receive` does, and keeps it (`src/lib/sealed-import.ts`, one
    implementation for both).
  - It then asks the server to drop the sealed copy.
- **What the server holds, and for how long.** Only ciphertext, sealed to a
  key that is non-extractable in the owner's browser; the server cannot open
  it. It is dropped when the owner's browser has kept the record, or after 30
  days.
  - Only the issuer may deliver, once, and only for an issued ask that
    carries a key.
  - Only the ask's owner may drop it.
- **Why this costs no privacy.** At issuance the server already sees the
  record in the clear, because `/api/issue` computes `d` and `C`. Holding the
  sealed form until the owner picks it up tells the server nothing new.
- **D3 now reads:** the sealed link or the issuance inbox; no file; the
  server holds no record in the clear and keeps only the sealed form, until
  pickup; no backup export.
- **What stays the same.**
  - **The SOW rule.** No request from the owner's browser contains the
    record or the secret. The owner's browser receives the sealed form in a
    response, and sends back only the ask id.
  - **Buyers and swaps.** They keep the sealed link, bound on chain by
    `request_record`. There the server never sees the record, so "No
    QuietStay server sees the record, the link or `d`" still holds for them.
  - **The reply link** remains on the issuer's screen as a fallback.
- **Issuer and owner in one browser** (a demo switching accounts). The
  issuer's own copy of the record is used directly. It is accepted only if,
  with a secret kept there, it reproduces the commitment on chain.
- **The no-leak test** now gets the owner's record through the inbox, with no
  link opened. It fails if any of the owner's requests carries part of the
  sealed record.

This design has these properties:

- An intercepted link is useless without the buyer's browser, because only
  that browser holds the private key.
- A swapped request link fails the key-hash check in step 3.
- No QuietStay server sees the record, the link or `d`.
- No file is picked or saved.
- Renters need none of this, because they never prove.

**No analytics at all on the receiving page (D4 change 3).**

- `/receive` lives in its own route group with its own root layout,
  `src/app/(sealed)/layout.tsx`. That layout includes no `SiteAnalytics`, no
  third-party script and no external font. Multiple root layouts mean the
  top-level `src/app/layout.tsx` moves into a `(site)` group, unchanged, for
  every other page.
- Next.js turns navigation across different root layouts into a full page
  load (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md`:
  "it'll trigger a full page reload"). An analytics script loaded on another
  page therefore never runs in the `/receive` document.
- The Step 2 no-leak test covers both kinds of link. It fails if:
  - `/receive` makes any request to an analytics endpoint
    (`/_vercel/insights`, `/_vercel/speed-insights`, `va.vercel-scripts.com`);
  - its HTML references one;
  - any request from any page contains any part of a fragment.

**If browser storage is lost** (cleared data, a new device, a private window),
**the holder can no longer prove for that week.** The week stays theirs, and
they can still use a rental they hold, but they can never rent it out or sell
it again. Nobody can recover it: not the issuer, not the builder. This is the
Phase 2 limitation 4, now tied to browser storage. A buyer who loses `s'`
before acceptance should cancel the offer, and the app warns about this. It is
stated in DESIGN.md "Known limitations".

**Proving runs in a Web Worker.** The worker loads `transfer.wasm` (1,971,529
bytes) and `transfer.zkey` (1,973,682 bytes) from the app's own static path. It
computes SHA-256 with `crypto.subtle.digest` and refuses to prove unless both
hashes equal the committed ones in `circuits/keys/SHA256SUMS`
(`5db51d96…91ea`, `a4d547d3…6ebf`). The hashes are compiled into the app, not
fetched. The worker uses snarkjs 0.7.5's browser build. It is the same version
as the CLI, so it produces the same proofs as the CLI and the existing tests
still apply. Inputs and outputs pass only through `postMessage` inside the
page.

**Licensing: decision D2.** snarkjs, the circuit and Poseidon are GPL-3.0
(`circuits/gpl/README.md`). Phase 2 kept every bit of GPL code out of the
browser (`npm run zk:check-bundle`). Browser proving cannot avoid it, because
the compiled circuit itself derives from circomlib's GPL Poseidon. Proposal:

- Put all GPL code in one separately built worker script
  (`public/zk/prover.worker.js`), licensed GPL-3.0 with its source in this
  repository.
- The Apache-2.0 app talks to it only by `postMessage`.
- Change `zk:check-bundle` so that GPL markers may appear **only** in that
  worker file and nowhere else.

D2 was approved with two additions:

- **A `LICENSE` file in the worker's folder.** The worker's source and build
  live in `prover-worker/`, which holds:
  - `prover-worker/LICENSE`: the GPL-3.0 text;
  - `prover-worker/README.md`: what is GPL, what it derives from, and how to
    rebuild it.

  The build output is `public/zk/prover.worker.js`. Its first comment line
  names the license and the source path, and a copy of the license is served
  as `public/zk/LICENSE`.
- **A license notice in the app.** It appears in the footer and on the screens
  that prove. The text: "Proofs are made by an in-browser prover licensed
  under the GPL-3.0 (source: `prover-worker/`, built from snarkjs and
  circomlib). The rest of QuietStay is Apache-2.0." It links to the license
  and the source. `zk:check-bundle` also checks that the notice and
  `public/zk/LICENSE` exist.

**No-leak test (Step 2).** A Playwright end-to-end test records every request
the page and the worker make (URL, headers, body) while it proves and submits
a sale and a rental. It fails if any request contains `s`, `s'`, the record
text, `d`, or `d_hi`/`d_lo` in decimal or hex.

## 3. The reusable transfer check

One function in `auth.rs` replaces today's `check_transfer_proof` +
`store::grant` + `consume_transfer_proof` sequence. Every flow calls it, and
nothing else writes `Right.holdings` or `Right.commitment`:

```rust
pub enum TransferMode {
    Sale,                         // mode signal = 0
    Rental { expires_at: u64 },   // mode signal = expires_at
    Swap { counter_right_id: u64 },// mode signal = 2^64 + counter_right_id
}

/// Checks that `proof` authorizes exactly this transfer, then applies it.
/// It does not call `require_auth`: each entry point obtains the holder's
/// authorization first, as Phase 2's `transfer` does (see the table below).
pub fn authorize_transfer(
    env: &Env,
    right: &mut Right,
    from: &Address,
    to: &Address,
    mode: TransferMode,
    next_secret_hash: &U256,      // expected h'; 0 for a rental
    proof: &Proof,
    signals: &Vec<U256>,
) -> Result<(), Error>
```

It runs, in order:

1. **Signals.** There must be 11 signals, all canonical. `commitment` must be
   the stored one. `right_id`, `from` and `to` must match (with item 1's
   encoding). `mode` must match the `TransferMode`. `expiry_ledger` must be
   within `[now, now + 720]`. `next_secret_hash` must equal the expected one:
   non-zero for a sale or swap, zero for a rental. The nullifier must be
   unused.
2. **Holding-chain rules:** the existing `store::grant`, with
   `expires_at = None` for a sale or swap and `Some(t)` for a rental.
3. **The pairing check** against the constructor's key. Then the nullifier is
   spent, with its TTL past `expiry_ledger`, as in Phase 2.
4. **Applied to `right`.** The new chain is written. For a sale or swap,
   `commitment = next_commitment` and the title balances move. The listing is
   removed.

The caller then calls `store::put_right` and emits its event. The caller never
has to remember a step. The only thing it supplies is the expected
`next_secret_hash`, which comes from on-chain state, never from the caller's
arguments:

| Flow | Holder auth (in the entry point) | `to` | `mode` | expected `h'` comes from |
| --- | --- | --- | --- | --- |
| `transfer` (Phase 2, no payment) | `from.require_auth()` | argument | Sale / Rental | buyer's `require_auth_for_args(right_id, h')`, as Phase 2 |
| `accept_sale` | seller `require_auth()` | `offer.buyer` | Sale | `offer.next_secret_hash` (the buyer set it when making the offer) |
| `accept_rental` | owner `require_auth()` | `offer.renter` | Rental { `offer.expires_at` } | `0` |
| `complete_swap`, maker's half | maker `require_auth()` | `acceptance.taker` | Swap { want_right } | `acceptance.taker_next_secret_hash` |
| `complete_swap`, taker's half | taker's `require_auth()` in `accept_swap`, covering this proof (see 7) | `offer.maker` | Swap { give_right } | `offer.maker_next_secret_hash` |

**`burn` (D11, approved with the change).** `burn` still needs only the title
holder's signature. It now also refuses, in this order:

| Condition | How it is detected | Error |
| --- | --- | --- |
| the right is rented out (a live sub-grant above the title holder) | `store::prune_lapsed` leaves more than one holding (Phase 2 rule, kept) | `NotTitleHolder` |
| the right has a Funded or Disputed escrow | `OpenEscrows(right_id) > 0` | `EscrowOpen` (new) |
| the right has a pending swap acceptance, as either `give_right` or `want_right` | `SwapPending(right_id)` exists and its acceptance is live | `SwapPending` (new) |

The escrow count stays positive after the rental itself has lapsed, as long as
the money is still in escrow, for example in a dispute. Burning is possible
again once the escrow is PaidOut or Refunded.

Tests (Step 3 for the escrow cases, Step 4 for the swap cases): burn refused
- while a rental is live;
- while an escrow is Funded, both before and after the rental term lapses;
- while an escrow is Disputed;
- while a swap acceptance is pending, on the taker's right and on the maker's
  right.

Burn succeeds:
- after PaidOut;
- after Refunded, once the refunded renter's term has lapsed;
- after the acceptance is withdrawn or has expired.

The Phase 2 burn tests stay.

The Phase 2 `ModeMismatch` and `NextSecretHashMismatch` errors cover the new
modes. The Phase 2 unit tests move onto this function unchanged in substance.

## 4. Sale offer

Your default works, with one refinement (decision D4): **the offer stores the
buyer's next secret hash `h'`, not the next commitment `C'`.**

- `C' = Poseidon(d, buyer, h')` needs the record digest `d`. The contract
  cannot compute it, because it never computes Poseidon.
- The seller's proof already outputs `C'`, bound to `h'` and the buyer.
- Storing `h'` and requiring `proof.next_secret_hash == offer.h'` gives the
  same guarantee, "the seller cannot plant a commitment", that Phase 2 got
  from the buyer's signature. The difference is that the buyer signs once, at
  offer time, and need not be online when the seller accepts.

**Why `C'` cannot be brute-forced now that `h'` is public (review of D4).**

- `C' = Poseidon5(d_hi, d_lo, to_hi, to_lo, h')`. Of its inputs, `to` and `h'`
  are public; `d` is not.
- `d = SHA-256(canonical record)`, and every record carries a `salt` of 32
  random bytes (docs/COMMITMENT.md, "The two fields that exist for the
  commitment's sake").
- Everything else in a record is low-entropy: dates, a resort, a name. The
  salt alone puts 256 bits of entropy into `d`. Guessing `d` from public data
  is therefore a 2^256 search, the same as for `C` today.
- `h'` was already public in Phase 2, where it travels in the buyer's
  authorization arguments, so D4 discloses nothing new.
- `d` is the same in every commitment of a week's history, by design (Phase 2
  §4). People who have held or been shown the record (past owners, buyers it
  was disclosed to) can compute `C'`. That gives them nothing: a proof needs
  `s'`.

```
request_record(buyer, right_id, key_hash: BytesN<32>, expires_ledger: u32) -> request_id   // §2, D4/D4a
cancel_record_request(buyer, request_id)
create_sale_offer(buyer, request_id, price: i128, next_secret_hash: U256, expires_ledger: u32) -> offer_id
cancel_offer(buyer, offer_id)
accept_sale(seller, offer_id, price: i128, proof, public_signals)
```

- **Record requests (D4a, approved option 1).**
  - `request_record` requires the requester's auth. The right must exist,
    `key_hash` must be non-zero, and
    `now < expires_ledger ≤ now + MAX_OFFER_LEDGERS`, so requests expire
    within the D9 limit, like offers.
  - Each requester has **at most `MAX_OPEN_REQUESTS_PER_BUYER = 10` live
    requests**, tracked like offers in `BuyerRequests(addr)`, which is pruned
    of expired and consumed ids on every request call.
  - A request is consumed when the offer or swap step that uses it succeeds.
    The requester can also cancel it.
  - **A request creates no obligation for the seller.** It is a temporary
    entry and nothing else. No function requires the holder to answer it; it
    has no deadline for the holder and no penalty. It does not block anything
    the holder may do: the holder can still sell to someone else, rent out,
    list, swap or burn the right. If the holder never sends the record, the
    request simply expires. It also moves no money and sets no allowance.
- **Create.** Requires `buyer.require_auth()`. Checks:
  - `RecordRequest(request_id)` is live, is the buyer's own, and names a right
    that exists and is active. The offer is for that right, copies `key_hash`
    (D4) and consumes the request;
  - `0 < price ≤ max_payment`, where `max_payment` is a constructor argument
    (D7);
  - `h'` is non-zero and canonical;
  - `now < expires_ledger ≤ now + MAX_OFFER_LEDGERS` (D9);
  - the buyer has fewer than `MAX_OPEN_OFFERS_PER_BUYER = 10` live offers
    (sale and rental together). This bounds the cost of the allowance
    recalculation below.

  Then it **sets the allowance (D12, approved)** and records the offer. The
  USDC stays in the buyer's account.
- **Accept.** Requires `seller.require_auth()`, covering `offer_id` and
  `price`. Then:
  - the offer must be live, and `price` must equal `offer.price`, so a seller
    accepts exactly the amount they saw (the "wrong amount" test);
  - `authorize_transfer(…, Sale, offer.h')`;
  - `usdc.transfer_from(spender = contract, from = buyer, to = seller, price)`;
  - the offer is deleted, it is removed from the buyer's index, and a
    `SaleSettled` event is emitted.

  Soroban transactions are atomic. If the allowance or the balance is too low,
  `transfer_from` traps and **nothing moves**: not the right, not the
  nullifier, not the offer.
- **Wrong token.** No function takes a token address. The USDC contract is
  fixed in the constructor (see the table below), so another token cannot be
  named at all.
- **Cancel.** Requires the buyer's auth, and the offer must be live. It
  removes the offer and sets the allowance again (D12).
- **Expiry.** After `expires_ledger`, acceptance is refused (`OfferExpired`).
  The entry sits in temporary storage and disappears once its TTL ends.

**The allowance model (D12, approved).** The allowance always equals the sum
of the buyer's open offers.

- The contract keeps a per-buyer index of the buyer's offer ids,
  `BuyerOffers(buyer)`, persistent and at most 10 entries.
- **Every buyer-authorized offer call** (`create_sale_offer`,
  `create_rental_offer`, `cancel_offer`) does three things:
  1. drops expired, accepted or cancelled offers from the index;
  2. computes `total` as the sum of the prices of the live open offers left;
  3. calls `usdc.approve(buyer, this, total, now + MAX_OFFER_LEDGERS)` as a
     sub-invocation the buyer authorizes in the same transaction.
- Every live offer expires by `now + MAX_OFFER_LEDGERS`, so that one
  expiration covers all of them.
- **Accepting** an offer pulls exactly its price with `transfer_from`, which
  lowers the allowance by that amount. The accepted offer leaves the index, so
  the equality still holds.
- **Offers that expire on their own.** No transaction runs at the moment an
  offer expires. Its price stays in the allowance until the buyer's next offer
  call recomputes the total, or until the allowance itself expires, whichever
  comes first. That leftover **cannot be pulled**: the contract calls
  `transfer_from` only inside `accept_sale` and `accept_rental`, only for an
  accepted offer that is still live, and only for that offer's price. This is
  documented in DESIGN.md.
- **A buyer may still change the allowance directly** with the USDC contract.
  If it is then too low or expired, the acceptance fails completely.
- The model is checked by the Step 3 allowance tests:
  - five offers on one allowance: one accepted, one cancelled, then the
    buyer's balance drops;
  - an allowance that expires before its offer;
  - an offer that outlives its allowance.

  In every case an offer completes in full or moves nothing, and after every
  buyer call the allowance equals the sum of the live open offers.

Constructor-fixed USDC addresses:

| Network | USDC issuer (Circle) | Stellar Asset Contract | Source |
| --- | --- | --- | --- |
| Testnet | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | issuer: <https://developers.circle.com/stablecoins/usdc-contract-addresses> (read 2026-11-19); contract: `stellar contract id asset --asset USDC:GBBD…LLA5 --network testnet` |
| Mainnet | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | same Circle page; `stellar contract id asset --asset USDC:GA5Z…KZVN --network-passphrase "Public Global Stellar Network ; September 2015"` |

Circle's page lists only the issuer form (`USDC-G…`). The contract address is
derived from it deterministically by the CLI command shown, and Step 5
double-checks it against the network.

## 5. Rental offer and escrow

```
create_rental_offer(renter, right_id, price, expires_at: u64, check_in: u64, expires_ledger) -> offer_id
accept_rental(owner, offer_id, price, proof, public_signals) -> escrow_id
```

**Acceptance is one transaction.** Requires `owner.require_auth()`. Then:

- `authorize_transfer(…, Rental { expires_at }, 0)` grants the rental right;
- `usdc.transfer_from(contract, renter, contract, price)` pulls the money into
  escrow;
- an `Escrow { right_id, owner, renter, amount, check_in, state: Funded,
  evidence }` is written.

If any part fails, nothing happens.

**Answers to your questions:**

- **Can check-in be earlier than acceptance? No.** Both creation and
  acceptance require `check_in ≥ now`.
- **Must check-in fall inside the rented period? Yes:**
  `right.period.start ≤ check_in < right.period.end` and
  `check_in + 24 h ≤ expires_at`. That way the first night is inside the term
  being paid for. `expires_at ≤ validity.until` holds already.
- **The problem-report window: confirmed as you expected,** from funding until
  `check_in + 24 h`.
  - It is the exact complement of the collect window: `report_problem` is
    allowed while `now < check_in + 86 400`, and `collect` only once
    `now ≥ check_in + 86 400`. There is no moment when both are possible, and
    no moment when neither is.
  - Both use ledger timestamps (seconds), not ledger counts.
- **The rental right after a refund stays until `expires_at`.** Nothing can
  touch a right: not the arbiter, not the owner, not the contract. A refunded
  renter therefore keeps the week until the term lapses. Stated plainly as a
  limitation, with the "future design" note in Step 7.

**State machine.** It has these transitions and no others:

```
               confirm (renter, any time)            ┌──────────┐
          ┌────────────────────────────────────────▶│ PaidOut  │
          │    collect (owner, now ≥ check_in+24h)   └──────────┘
 ┌────────┴┐                                           ▲    ▲
 │ Funded  │                                 confirm   │    │ resolve(PayOwner)
 └────┬────┘                                 (renter)  │    │ (arbiter)
      │ report_problem (renter, now < check_in+24h) ┌──┴────┴──┐
      └────────────────────────────────────────────▶│ Disputed │
                                                    └──┬────┬──┘
                                   refund (owner)      │    │ resolve(RefundRenter)
                                                       ▼    ▼ (arbiter)
                                                    ┌──────────┐
                                                    │ Refunded │
                                                    └──────────┘
```

| Function | Caller | Allowed when | Effect |
| --- | --- | --- | --- |
| `collect(owner, id)` | `escrow.owner` | Funded and `now ≥ check_in + 86 400` | pay owner → PaidOut |
| `confirm(renter, id)` | `escrow.renter` | Funded or Disputed | pay owner → PaidOut |
| `report_problem(renter, id, evidence_hash)` | `escrow.renter` | Funded and `now < check_in + 86 400` | → Disputed; hash recorded |
| `refund(owner, id)` | `escrow.owner` | Disputed | pay renter → Refunded |
| `submit_evidence(by, id, hash)` | `escrow.owner` or `escrow.renter` | Disputed | hash recorded (bounded, D10) |
| `resolve(arbiter, id, outcome, decision_hash)` | the constructor's arbiter | Disputed | PayOwner → PaidOut or RefundRenter → Refunded; decision hash recorded |
| `extend_escrow(id)` | anyone | any state | TTL only, no state change (item 9) |

- PaidOut and Refunded are final, so double payout, double refund and refund
  after payout are all rejected (`EscrowNotInState`).
- The arbiter has exactly one function. It takes an escrow id and an outcome.
  There is no address and no amount to choose. It can pay only `escrow.owner`
  or `escrow.renter`, and only `escrow.amount`.
- It cannot reach a right, because nothing in `resolve` reads or writes
  `Right`. A test checks that, and Step 5 checks it against the code.
- A dispute has no timeout, exactly as specified. If neither party gives way
  and the arbiter never acts, the money stays in escrow. That is a pilot
  limitation.
- A payout to a `G…` account needs a USDC trustline. If it is missing, the
  payout fails and can be retried after the trustline is added. A `C…`
  account needs none.

**Invariant (Step 3 test):** the contract's USDC balance always equals the sum
of the amounts of Funded and Disputed escrows. Sales never touch the contract's
balance, because `transfer_from` pays the seller directly.

## 6. Evidence files

- The browser hashes the chosen file with `crypto.subtle.digest('SHA-256')`
  and submits only the 32-byte hash. The file is not uploaded anywhere, and
  there is no server storage.
- On chain, each escrow keeps the hashes in its own entry: the problem report,
  up to 4 from each party, and the arbiter's decision. They are also emitted as
  events. Storage is used because public RPC event history is short-lived, and
  a reviewer must be able to read the hashes from current state.
- **Pilot:** the sample evidence files are committed under `pilot/evidence/`,
  and `sha256sum pilot/evidence/*` reproduces every on-chain hash. Real upload
  storage is not needed.

## 7. Swap

**Mode encoding.** `mode = 2^64 + counter_right_id`. Sales use `0` and rentals
use a `u64` timestamp, which is below 2^64, so the three ranges never overlap.
Each proof therefore names the week it is swapped **for**, and a swap proof
cannot be used as a sale proof or for a different swap. The nullifier includes
`mode`, so the same `s` produces different nullifiers for different
transfers. **The circuit expresses this without changes:** `mode` is already a
free public field element, constrained only by the nullifier.

**Flow: three on-chain steps (decision D5).** Every step is signed by its own
party, and no off-chain coordination channel is needed:

0. **Each side requests the other's record first (D4a).**
   - The maker signs `request_record(maker, want_right, key_hash_m)`.
   - The prospective taker signs `request_record(taker, give_right, key_hash_t)`.
   - Each receives the other's sealed record and checks it against the current
     on-chain commitment, as in §2.
1. **`offer_swap(maker, give_right, want_right, maker_next_secret_hash, maker_request_id, expires_ledger) -> swap_id`.**
   Requires the maker's auth. The maker must be the effective title holder of
   `give_right` at this point (this is checked again later). The maker's
   request must be live, the maker's own, and for `want_right`. Its
   `key_hash_m` is copied into the swap and the request is consumed.
2. **`accept_swap(taker, swap_id, taker_next_secret_hash, taker_request_id, proof_t, signals_t)`.**
   Requires the taker's auth, covering this exact proof. The taker's request
   must be live, the taker's own, and for `give_right`. Its `key_hash_t` is
   copied into the acceptance and the request is consumed. The cheap signal
   checks run now, with `want_right` moving to the maker under
   `Swap { give_right }` and `h' = maker_next_secret_hash`. The proof and the
   taker's `h'` are stored in a temporary entry that lives until the proof's
   `expiry_ledger`, at most 720 ledgers (about an hour).
3. **`complete_swap(maker, swap_id, proof_m, signals_m)`.** Requires the
   maker's auth. `authorize_transfer` runs twice, in one transaction:
   - first for the taker's stored proof (`want_right` → maker,
     `Swap { give_right }`, `h' = maker_next_secret_hash`);
   - then for the maker's proof (`give_right` → taker, `Swap { want_right }`,
     `h' = taker_next_secret_hash`).

   Both rights take their new commitments, and the swap entries are deleted.
   Any failure, such as a side that is expired, rented out, already
   transferred, held by someone else, or carrying a reused proof, reverts both.

The maker can cancel the offer at any time, and the taker can withdraw an
acceptance. An acceptance that is never completed simply expires with its
proof.

**Confirmations requested in review (D5):**

- **The taker's right is not locked between accept and complete.**
  `accept_swap` writes only the acceptance entry (`Swap(id)` /
  `SwapAcceptance(id)`) and never writes `Right(want_right)`. The taker can
  still rent out or sell `want_right`, or accept a different offer for it. If
  they do, `complete_swap` fails, as listed below, and nothing moves. The one
  exception is `burn`: per D11 it is refused while a swap acceptance is
  pending on the right. The taker withdraws the acceptance first.
  The same holds for the maker's `give_right`. A Step 4 test sells the taker's
  right between accept and complete and checks that complete is refused and
  both rights are unchanged.
- **The taker can withdraw.** `withdraw_swap_acceptance(taker, swap_id)`
  requires the taker's auth and deletes the acceptance, so the stored proof
  can no longer be used. The proof's nullifier was never spent, because
  `accept_swap` only checks and stores. The offer stays open for a new
  acceptance. A second `accept_swap` is refused while a live acceptance
  exists, and allowed once that acceptance is withdrawn or expired.
- **`complete_swap` re-checks every refusal condition. Nothing checked in
  `accept_swap` is trusted.**
  - The offer must exist, be live (`now ≤ expires_ledger`) and not be
    cancelled. The acceptance must exist and not be withdrawn.
  - Both proofs run the full `authorize_transfer` against the current state:
    - commitment equal to the one stored now (refuses a right already sold,
      including by its other owner);
    - `from` is the current effective title holder with no live rental (refuses
      a right rented out, held by someone else, or never theirs);
    - right inside its validity window (refuses an expired right);
    - `right_id`, recipient and `Swap { counter_right_id }` match;
    - `expiry_ledger` within `[now, now + 720]` (refuses an expired proof);
    - `next_secret_hash` equal to the other side's stored `h'`;
    - nullifier unused (refuses a reused proof);
    - the pairing check.
  - `give_right ≠ want_right` and `maker ≠ taker` (`SelfTransfer`), checked
    again.

  Each refusal reverts the whole transaction: neither right, neither
  nullifier and neither entry changes. Step 4's tests cover each case on both
  sides.

The alternative is one transaction carrying both parties' auth entries and both
proofs. It saves a step but needs the two browsers to exchange signed
authorization entries off chain. The three-step flow keeps that exchange on
the ledger.

## 8. Contract layout

**One contract, `quietstay-rights`, with modules:**

- `auth.rs`: the boundary, item 3;
- `store.rs`;
- `offers.rs`: sale and rental offers;
- `escrow.rs`: the state machine;
- `swap.rs`;
- `payment.rs`: the only module that calls the USDC token.

Why one contract:

- A separate escrow or swap contract would have to move rights in the rights
  contract. That needs exactly the privileged cross-contract call the SOW
  forbids, or a second code path.
- With everything inside one contract, every right movement goes through
  `authorize_transfer`, and every USDC movement goes through `payment.rs`.

The only cross-contract calls are to the fixed USDC contract. The size budget
is comfortable: the Phase 2 rights WASM is 27,490 bytes, and both networks
allow 131,072 bytes (`stellar network settings`, 2026-11-19).

Constructor:
`__constructor(issuer, arbiter, usdc, name, symbol, verification_key, max_payment: i128)`.
It has no setter for any of these, no `upgrade` and no admin.

**One WASM for both networks (D7, approved with the change).** Everything that
differs between testnet and mainnet is a constructor argument, stored in
instance storage and never compiled in:

- the issuer, the arbiter and the USDC address;
- `max_payment`: 10,000,000 units (1 USDC) on mainnet and 1,000,000,000 units
  (100 USDC) on testnet. `max_payment ≤ 0` is refused.

Contract constants (`MAX_PROOF_WINDOW`, `MAX_OFFER_LEDGERS`,
`MAX_OPEN_OFFERS_PER_BUYER`, the evidence limit, TTL values) are the same on
both networks. One build is deployed twice, so the WASM hash is identical.

- The pre-launch checklist compares the two on-chain hashes.
- A view, `max_payment()`, lets anyone read the cap, and the checklist prints
  it for both networks.

## 9. Storage and TTL

The limits below were read on 2026-11-19 with `stellar network settings`
(mainnet through `--rpc-url https://mainnet.sorobanrpc.com`):

| Setting | Testnet | Mainnet |
| --- | --- | --- |
| max entry TTL | 3,110,400 ledgers | 3,110,400 ledgers |
| min persistent TTL | 120,960 | 2,073,600 |
| min temporary TTL | 720 | 17,280 |

| Data | Storage | TTL rule |
| --- | --- | --- |
| Config, verification key, arbiter, USDC, id counters | instance | extended on every call (Phase 2 `bump_instance`) |
| Rights, title balances | persistent | extended on every read and write (Phase 2) |
| Nullifiers | temporary | live-until > `expiry_ledger` (Phase 2 rule, unchanged) |
| Sale and rental offers | temporary | live-until > `expires_ledger`. An expired offer is dead, so losing it is harmless |
| Swap offers and acceptances | temporary | until `expires_ledger` / the stored proof's `expiry_ledger` |
| Record requests (`RecordRequest(id)`, D4/D4a) | temporary | live-until > their `expires_ledger` (≤ D9 lifetime); deleted when consumed or cancelled |
| Requester index (`BuyerRequests(addr)`, D4a) | persistent | ≤ 10 ids, pruned on every request call; extended like rights |
| Buyer offer index (`BuyerOffers(buyer)`, D12) | persistent | ≤ 10 ids, pruned on every buyer call; extended like rights |
| Burn guards (`OpenEscrows(right_id)`, a count; `SwapPending(right_id)`, D11) | persistent / temporary | the count is changed only on funding (+1) and on PaidOut/Refunded (−1); `SwapPending` lives exactly as long as the acceptance it guards |
| **Escrows** | **persistent** | see below |

**Escrows** are extended at funding and on every call that touches them, to
`min(max entry TTL, ledgers until check_in + 24 h + 30 days)`.

- A persistent entry is never deleted. When its TTL lapses it is *archived*,
  and it can be restored. On current protocols a transaction that touches an
  archived persistent entry restores it automatically.
- The documented ways to keep one live are:
  - `extend_escrow(id)`, which anyone can call, changes nothing else, and is
    listed in the permissions table;
  - `stellar contract extend --durability persistent --key-xdr <Escrow(id)> --ledgers-to-extend <n>`;
  - `stellar contract restore` if one was archived.
- The pre-launch checklist (Step 5) records the commands and a dry run of each.

## 10. Permissions

"State" is the condition under which the call succeeds. Every other caller or
state is rejected.

| Function | Who can call | When |
| --- | --- | --- |
| `__constructor` | deployer, once | deployment |
| `name`, `symbol`, `decimals`, `balance`, `issuer`, `arbiter`, `usdc`, `max_payment`, `next_id`, `get_right`, `commitment`, `holder`, `holding`, `holdings`, `is_active`, `get_listing`, `get_record_request`, `get_offer`, `get_escrow`, `next_request_id`, `next_offer_id`, `next_escrow_id`, `get_swap`, `get_swap_acceptance`, `next_swap_id` | anyone (read-only) | always |
| `issue` | issuer | always; fresh ids only |
| `list`, `unlist` | effective holder | right active |
| `transfer` (no payment) | effective holder + valid proof (+ buyer's signature on a sale) | right active |
| `burn` | title holder | no live rental, no Funded/Disputed escrow, no pending swap acceptance (D11) |
| `request_record` | anyone, as prospective buyer or either side of a swap (own auth) | right exists; ≤ 10 live per requester; ≤ D9 lifetime; moves nothing and obliges no one |
| `cancel_record_request` | the requester | request live |
| `create_sale_offer` | the buyer named in a live `RecordRequest` for that right (own auth) | right active; limits in item 4 |
| `create_rental_offer` | anyone, as renter (own auth) | right active; limits in item 5 |
| `cancel_offer` | the offer's buyer or renter | offer live |
| `accept_sale` | effective title holder + valid proof | offer live, price matches |
| `accept_rental` | effective holder + valid proof | offer live, check-in rules |
| `collect` | escrow owner | Funded, `now ≥ check_in + 24 h` |
| `confirm` | escrow renter | Funded or Disputed |
| `report_problem` | escrow renter | Funded, `now < check_in + 24 h` |
| `refund` | escrow owner | Disputed |
| `submit_evidence` | escrow owner or renter | Disputed |
| `resolve` | arbiter | Disputed |
| `extend_escrow` | anyone | any (TTL only) |
| `offer_swap` | effective title holder of `give_right` | right active |
| `cancel_swap` | the swap's maker | swap live |
| `accept_swap` | effective title holder of `want_right` (own auth) | swap live |
| `withdraw_swap_acceptance` | the taker | acceptance live |
| `complete_swap` | the swap's maker + valid proof (taker's proof stored) | acceptance live, both proofs within their window |

**The SEP-45 web-auth contract** (added at the Step 2 review). This is a
separate contract, used only to sign in smart wallets:
`contracts/vendor/anchor-web-auth/`, from stellar/java-stellar-anchor-sdk @
`dc5817fb`, unmodified. Testnet: `CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM`.
Mainnet: deployed by us later. It holds no rights, no money and no QuietStay
state. The rights contract never calls it, and it never calls the rights
contract.

| Function | Who can call | When / effect |
| --- | --- | --- |
| `__constructor(admin)` | the deployer, once | stores `admin`. QuietStay passes `CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2`, the contract id SHA-256("QuietStay SEP-45 web-auth: no admin"). No contract exists there or can be created there |
| `web_auth_verify(args)` | anyone | requires the authorization of `args.account` and `args.web_auth_domain_account`, and of `args.client_domain_account` if present. Writes nothing but those addresses' auth nonces. The server only simulates it, and never submits it |
| `upgrade(new_wasm_hash)` | `admin` only | **unreachable**: the admin address can never authorize, so the code cannot change. This is how the "no upgrade, no admin key" rule holds for a contract we reuse unmodified |

**Outside accounts.** No allowlist is needed. Money moves only in
`accept_sale`, `accept_rental`, `collect`, `confirm`, `refund` and `resolve`.
Rights move only through `authorize_transfer`.

- An outsider can make an offer, but nothing moves unless a builder-held
  right's holder accepts it with that holder's proof.
- An outsider can be an escrow's renter only if a builder owner accepted their
  offer.
- An outsider can complete a swap only for a swap whose maker is that
  outsider, and a swap moves a builder right only if the builder accepted with
  a proof.
- `resolve` is the arbiter's alone, and the arbiter is a builder account.

I found **no path where an outside account moves USDC or a right without a
builder-account action.** The Step 3 outside-account tests check this for
every function.

## 11. Early swap cost estimate

**Measurement.** One `--send=no` simulation on testnet of a transaction that
verifies two existing Phase 2 proofs (`tests/fixtures/sale.json` and
`rental.json`, both made by `npm run zk:test-fixtures`) in one call:

- Contract: `contracts/quietstay-measure`. It runs the rights contract's own
  `verifier.rs`, included by path, twice. Measurement only.
- Deployed: [`CCKL74S5L57GZ32K2AWIIRGKNED3CZNWFCM62BMVASLMSHJXOYK4ZLY4`](https://stellar.expert/explorer/testnet/contract/CCKL74S5L57GZ32K2AWIIRGKNED3CZNWFCM62BMVASLMSHJXOYK4ZLY4),
  in tx [`5ffde55c…74aa`](https://stellar.expert/explorer/testnet/tx/5ffde55c074ad7a5e8c2daebbd9645b7dbdf86c43bfec1405fee8f6300b574aa),
  with the committed verification key.

| | Value | % of per-tx limit | Command |
| --- | --- | --- | --- |
| Result | `true`: both proofs verified | | `stellar contract invoke --id CCKL…ZLY4 --network testnet --send=no -- verify_two …` |
| CPU, simulated (WASM) | **171,992,473** instructions | **43.0%** of 400,000,000 | RPC `simulateTransaction`, ledger 5,811,197 |
| Minimum resource fee, simulated | 61,546 stroops | | same |
| Ledger bytes read / written | 0 / 0 | | same |
| Memory, local host budget | **648,933** bytes | **1.5%** of 41,943,040 | `cargo test -p quietstay-measure -- --nocapture` |
| CPU, local host budget (native, no VM) | 150,094,049 instructions | | same |
| Transaction size | ~1,890 bytes (two proofs) | 1.4% of 132,096 | from the simulated envelope |

Both networks have the same per-transaction CPU and memory limits (400,000,000
instructions; 41,943,040 bytes), read with `stellar network settings` on
2026-11-19. The RPC's simulation response does not report memory, so memory
comes from the local budget, as in Phase 2.

**Estimate for the integrated swap.** The two pairings above (172.0 M) plus two
transfers' bookkeeping. Phase 2 measured that bookkeeping at 1.46 M instructions
per transfer: the sale simulation, 80,352,655, minus the verify-only
simulation, 78,896,206 (docs/CIRCUIT.md). Adding the stored acceptance and the
offer reads (*estimate:* a few million more), the total is **about 175–180 M
instructions, about 45% of the limit**. Memory stays under 2%, and storage
reads stay well inside 200 entries and 200,000 bytes. **A two-proof swap fits
with room to spare.** Step 4 measures it again on the integrated contract, by
simulation and then with one real transaction, as planned.

## 12. Pinned versions

| Component | Version | Why / compatibility check |
| --- | --- | --- |
| Smart Account Kit (`smart-account-kit`, npm, Apache-2.0) | **0.10.0** | latest (published 2026-10-27). Needs `@stellar/stellar-sdk ^16.4.1` and `@simplewebauthn/browser ^13.3.0`. Its `@creit-tech/stellar-wallets-kit` peer dependency is **optional**. Indexer and relayer are optional (`indexerUrl: false`, no `relayerUrl`), so no hosted service is used. Wallets are deployed with `createWallet(…, { autoSubmit: false })` and submitted from a funded source we control |
| OpenZeppelin smart account | **stellar-accounts v0.8.0** (OpenZeppelin/stellar-contracts `ddc327eb`), account WASM `c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1` | the build the kit recommends for new wallets. Built by the kit's maintainers with soroban-sdk 28.0.0. QuietStay does not compile it; it is a separate contract. WebAuthn verifier: **since the Step 5 review (2026-11-22), QuietStay's own instance** of OpenZeppelin's uploaded verifier WASM `e63a030d…` (no constructor, admin or `upgrade`): testnet `CBK3H55VKCKZ4LRIZSETP3ZYP4OI4IIBN3SCCCFNYI5WDFC45PSWWEEL`, mainnet deployed in Step 6. Before that, the kit's manifest instances, testnet `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` and mainnet `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR`; they were someone else's instances (checklist §5.4) |
| `@stellar/stellar-sdk` | **16.4.1** (from 16.2.0) | the kit's range is `^16.4.1`; 17.x is outside it. `@creit.tech/stellar-wallets-kit` 2.5.0 needs `^16.0.0`, so the SDK dedupes. Checked: `npm install --dry-run smart-account-kit@0.10.0 @stellar/stellar-sdk@16.4.1` resolves with no conflicts |
| `@creit.tech/stellar-wallets-kit` | **2.5.0** (unchanged) | the fallback wallet |
| soroban-sdk (QuietStay contracts) | **27.0.6** (unchanged) | Phase 2's tested base. Latest stable is 29.0.1 and 30.0.0 is an RC. A 27.0.6 build runs on testnet's protocol 30 today (the item 11 contract). Mainnet runs protocol 29 (RPC `getNetwork`), and the Step 5 checklist confirms deployment there by simulation |
| circom | **2.2.2** (unchanged) | the circuit and keys are unchanged |
| snarkjs | **0.7.5** (unchanged) | the same version in the CLI and the browser worker (its `build/browser.esm.js`), so both produce the same proofs. 0.7.6 exists, but nothing needs it |
| Stellar CLI | **30.0.1** (from 27.0.0) | 27.0.0 warns: "Network protocol version is 30 but the stellar-cli supports 27". Upgrade before Step 2 |

The versions are pinned exactly in `package.json`/`package-lock.json` and
`contracts/Cargo.lock`, and recorded in `docs/SETUP.md`, in Step 2. The real
proof that they work together is the first passkey-authorized testnet contract
call, which Step 2 makes before building any screen.

**Supported browser target (Step 2 confirms):** current desktop Chrome with a
platform passkey (Google Password Manager, or Windows Hello on Windows). The
app checks `PublicKeyCredential` and
`isUserVerifyingPlatformAuthenticatorAvailable()`. If either is missing, it
says so and points to the regular wallet.

---

## 13. Fees for passkey transactions (D6, approved with conditions)

A smart wallet cannot be a transaction's source, so a `G…` account pays every
fee.

### Testnet: the fee route

`POST /api/tx/sponsor` takes a transaction or `{func, auth}` built and
passkey-signed in the browser. It signs the envelope with
`QUIETSTAY_TESTNET_FEE_SECRET` and submits. The route enforces the following.

**It refuses every transaction except:**

- exactly one `InvokeHostFunction` operation that either:
  - **calls a QuietStay contract** (the configured rights contract id; the
    function name is not restricted, since the contract does its own auth);
    or
  - **deploys a smart wallet**: `CreateContractV2` whose executable is the
    pinned OpenZeppelin account WASM `c514d35e…`, via the kit's deployer;
- every sub-invocation in the auth entries stays inside the QuietStay
  contract, the fixed USDC contract (only the `approve` / `transfer` the
  rights contract itself calls, see D12) and the smart wallet's own
  `__check_auth`;
- the fee account appears nowhere except as source and fee payer: not in any
  argument, not as an auth address, not as a holder;
- fee ≤ 10,000,000 stroops (1 XLM) per transaction, and source = the fee
  account.

**Rate limits**, kept in the deployment's existing Upstash store
(`src/lib/kv.ts`, so no new infrastructure):

- 10 sponsored transactions per IP per hour;
- 20 per smart-wallet address per day;
- 300 per day in total.

When the store is unreachable, the route refuses rather than signing
unlimited. The account is funded with a small testnet balance (Friendbot), so
the balance is a hard bound as well.

**The key has no other role.**

- It is the identity `qs-fee-testnet` (`GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z`).
  Step 2 review (2026-11-19): you approved this existing identity as the
  fee key and set its secret as `QUIETSTAY_TESTNET_FEE_SECRET` yourself, in
  Vercel and `.env.local`. New identities are created by you, never by the
  builder.
- At startup the route refuses to run if the fee address equals the issuer,
  the arbiter, the SEP-10 key, or any holder named in the inventory.
- `scripts/check-fee-account` checks on chain that it holds no rights and no
  USDC.
- The route is compiled out of the mainnet deployment: it refuses whenever
  the network passphrase is not testnet's. On testnet only, it is the one
  server-side signing key Phase 3 adds.

### Mainnet: the CLI signing flow (no server key)

1. **Build and sign the auth entry in the browser.**
   - The app builds the transaction with the source set to the address of the
     mainnet fee identity, which you type in once; the app keeps the public
     key only.
   - It simulates the transaction, and the passkey signs the smart wallet's
     auth entry with
     `signatureExpirationLedger = min(proof.expiry_ledger, latest + 720)`.
     That is up to 720 ledgers, about an hour at mainnet's roughly 5–6 s
     ledgers, which is long enough to sign and submit by hand.
   - It re-simulates with the real signature, because a WebAuthn signature is
     larger than the placeholder.
   - The transaction's time bound is the same one hour.
   - The app shows the unsigned envelope XDR, with a copy button.
2. **Sign and submit with `scripts/mainnet-sign-submit.sh <xdr-file> <identity>`.**
   The script:
   1. refuses unless `--network mainnet` and the identity are given explicitly;
   2. decodes and prints, in plain words, the operation, the contract, the
      function, the arguments, every auth address and the USDC amount
      (`stellar tx decode`);
   3. re-simulates and prints the fee and resources, then refuses if any
      payment exceeds the D7 cap or the auth entry expires within the next 60
      ledgers;
   4. asks you to type `SEND`;
   5. runs `stellar tx sign --sign-with-key <identity> --network mainnet` and
      `stellar tx send --network mainnet`;
   6. prints the hash and the Stellar Expert link.

   The script never reads the secret key itself; the CLI keystore signs.
3. **If the source's sequence number moved** (any other transaction from the
   same identity in between), sending fails. The script says so, and you
   rebuild in the browser.

The same script is exercised on testnet in Step 2, with a testnet identity, so
its first mainnet use in Step 6 is not its first run.

## 14. Pre-launch checklist additions from the review

These are added to `docs/PRELAUNCH_CHECKLIST.md` (Step 5), each with a command
and its output.

- **Same WASM, network values only in the constructor (D7).** The on-chain
  WASM hash of the testnet and mainnet contracts is identical. `max_payment()`,
  `usdc()`, `arbiter()` and `issuer()` are read back from each and printed side
  by side.

- **Built and tested for mainnet's current protocol.**
  - Mainnet runs protocol **29** and testnet **30** (RPC `getNetwork` /
    `getVersionInfo`, 2026-11-19).
  - The contracts are built with soroban-sdk 27.0.6. The WASM's environment
    metadata declares **protocol v27**
    (`stellar contract info env-meta --wasm …quietstay_rights.wasm` →
    `Protocol: v27`, checked today for the Phase 2 and measurement WASMs),
    which mainnet's protocol 29 accepts.
  - The checklist records that output for the final WASM.
  - It also records a mainnet `--send=no` simulation of the deploy and of
    each flow, run before GO.
- **No protocol-30-only features.**
  - The SDK pinned at 27.0.6 cannot emit host functions newer than protocol 27.
  - The checklist also lists every host function and SDK feature the
    contracts use, from `stellar contract info interface` and the source, and
    confirms each exists on protocol 29.
  - The OpenZeppelin account and verifiers are already deployed on mainnet by
    their maintainers; the checklist records their on-chain WASM hashes.
- **Re-checked if mainnet upgrades during the sprint.**
  - A pinned check, `scripts/check-protocol`, prints both networks' protocol
    versions and fails if mainnet is not 29.
  - It runs at Step 5 and again immediately before every mainnet transaction
    in Steps 6–7.
  - If mainnet has moved, mainnet work stops. The checklist's protocol,
    simulation and cost items are re-run, and the result is reported to you
    before anything else is sent.
- **The SEP-45 web-auth contract** (Step 2 review), each item with command
  and output, for testnet and mainnet side by side:
  - The WASM hash equals the build from the pinned source:
    `708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1`, from
    `cd contracts/vendor/anchor-web-auth && stellar contract build`, then
    `sha256sum`. It must be identical on both networks, and the source must
    be byte-identical to stellar/java-stellar-anchor-sdk @ `dc5817fb`.
  - The stored `Admin` is `CDA2IFOT…33G2`, and that address has no contract
    instance. Command: `npx tsx scripts/check-web-auth.ts --network testnet`
    and `--network mainnet --id <mainnet web-auth id>`. Both must pass. The
    deployment was approved as is at the Step 2 review: unmodified, with an
    unauthorizable admin.
  - The declared protocol (v26 today) is at most mainnet's.
  - `SIGNING_KEY` (the SEP-10/SEP-45 server account) exists on the network,
    because `web_auth_verify` asks for its authorization.
- **The sign-in signing key on mainnet: the one listed exception to "no
  server key on mainnet"** (approved at the Step 2 review). Each point is
  checked on chain:
  - It is the CLI identity **`mainnet-test`**, a separate identity from the
    testnet `qs-sep10-server` (Step 2 checkpoint decision). Its public key is
    `GCEF3BTQVDJ473URMW4556VG67YAPS2J5OP77FBXT7T47M2DOIZ7TDAR`, read with
    `stellar keys public-key mainnet-test` on 2026-11-20. It is used only in
    Step 6, as the server-side sign-in key; its secret is never read, printed
    or used by the builder for anything else.
  - **Before its secret goes to the server, you reduce its balance to the
    minimum.** It held XLM when it was recorded. The checklist records the
    balance read back from mainnet (`stellar` / Horizon `accounts/<G…>`) after
    you reduce it, and Step 6 does not configure the server until that item
    passes.
  - It is not the issuer, the arbiter, a holder of any right, or the fee
    payer of any transaction; it appears in no contract's state.
  - It holds only the minimum balance. You fund it yourself. The builder
    gives you its public key before mainnet.
  - It signs only sign-in challenges, which are never submitted.
  - `/.well-known/stellar.toml` names the endpoint, the contract id and the
    signing key, and they match the deployment.
  - The SEP-45 tests (`e2e/passkey.spec.ts`: sign-in; unsigned, replayed and
    tampered challenges refused) pass against that deployment.
- **Pilot funds are never sent to the contract address directly** (Step 3
  review). USDC sent to the rights contract with the token itself, outside
  an offer or escrow, is stuck forever (DESIGN.md known limitation 17).
  Checked on chain on both networks:
  - the contract's USDC balance equals the sum of Funded and Disputed
    escrows (`usdc.balance(contract)` against `get_escrow` for
    `1..next_escrow_id()`), before GO and after each pilot transaction;
  - no pilot account's USDC history shows a plain transfer to the contract
    address (Horizon `accounts/<G…>/payments` and the token's `transfer`
    events);
  - `scripts/mainnet-sign-submit.sh` refuses an envelope whose operation is
    a USDC `transfer` to the contract address (added before Step 6).
- **Every G account that will receive USDC in the mainnet pilot has a USDC
  trustline first** (Step 3, 2026-11-20). The token refuses to credit a G
  account without one. On testnet the first sale acceptance was refused in
  simulation for exactly this (token error #13, `qs-owner`). C accounts hold
  the token's balance without a trustline and are not on the list. The
  checklist lists each G account with its role and why it receives USDC:
  - a seller, paid by `accept_sale`;
  - an owner, paid by `collect`, by the renter's `confirm` and by the
    arbiter's `resolve(PayOwner)`;
  - a renter, paid back by `refund` and `resolve(RefundRenter)`;
  - any pilot account that USDC is moved to between pilot accounts.

  For each one, the evidence is Horizon `accounts/<G…>` showing a balance
  line for `USDC:<Circle's mainnet issuer>`, or the USDC contract's
  `balance(<G…>)` returning a number rather than "trustline entry is
  missing", read before GO. A trustline is not removed while that account is
  the owner or renter of a Funded or Disputed escrow, and the check is
  repeated before each mainnet acceptance. The app also tells a seller or
  owner without one before they accept, and refuses to start the acceptance
  (`/stays`, `needsUsdcTrustline` in `src/lib/usdc.ts`).
- **One server log per test run, never overwritten** (recorded 2026-11-21).
  `e2e/lib/app.ts` streams each run's `next dev` output to
  `e2e/results/logs/next-dev-<time>-port<port>-<random>.log`. The file is
  opened with `wx`, so it can never replace another, and is written as the
  server writes. `e2e/lib/failures.ts` writes
  `e2e/results/logs/failed-requests-<spec>-<run>.json` the same way. Before
  this, a later spec on the same port overwrote the log holding a network
  drop's error code. The checklist records two consecutive runs on the same
  port leaving two logs (done 2026-11-21: `passkey.spec.ts` twice on port
  4322).
- **Submission recovery on mainnet** (recorded 2026-11-21). If a submission
  fails on the network, the transaction is looked up by its hash first. If
  it is not on chain, the *same signed envelope* is sent again. A new
  transaction is never built and signed for the same action.
  `scripts/mainnet-sign-submit.sh` enforces it:
  - it signs an envelope once, and keeps the signed envelope and its hash in
    `<xdr-file>.submission/` before sending;
  - it refuses to sign the same file again, and points to `--resume`;
  - after a send, it polls `stellar tx fetch result --hash`. SUCCESS or
    FAILED: it stops. Confirmed not found: it resends the same envelope, at
    most 3 sends. Unknown (the lookup failed): it never resends on that
    basis, and stops with the `--resume` command;
  - "can no longer be included" (bad sequence, time bound): it stops,
    re-signs nothing, and says to check on chain before anything new;
  - `--resume` looks the hash up first and asks for RESEND.

  The checklist records the testnet rehearsal of each path (done
  2026-11-21, see PHASE3_PROGRESS.md) and repeats the "not found" path on
  testnet before GO. Any other mainnet sender used in Steps 6–7 (for example
  the CLI deploy) follows the same rule by hand: look up by hash, then
  resubmit the same signed envelope.
- **Privacy evidence** (Step 2 review): every evidence transaction has its
  `check-privacy` output in `evidence/privacy/`, made right after the
  transaction, with its events.
- **Step 5 (2026-11-21): the checks above as scripts.** All read-only:
  - `scripts/check-protocol.ts`;
  - `scripts/check-vk.ts --network <net> --contract <C…>`, the on-chain key
    against the committed one, and its hash;
  - `scripts/check-fee-account.ts`, named in §13;
  - `scripts/check-pilot-accounts.ts --network mainnet --accounts …`: each G
    account's trustline, and the D7 total ≤ 5 USDC;
  - `scripts/mainnet-simulate-upload.ts`, a simulation only.

  `scripts/mainnet-sign-submit.sh` runs `check-protocol` and
  `check-pilot-accounts` before every mainnet signature (`QS_PILOT_ACCOUNTS`,
  `QS_RIGHTS_CONTRACT`). `tx-review.ts` refuses a USDC `transfer` to the
  rights contract. Results: docs/PRELAUNCH_CHECKLIST.md.

## Step 3 implementation notes (for review at the Step 3 checkpoint)

Built in Step 3, 2026-11-20. These are the points where the code adds to, or
pins down, what the sections above say. None changes an approved decision;
each is listed so the Step 3 review can accept or reject it.

1. **The arbiter cannot be the issuer.** The constructor refuses
   `arbiter == issuer` (and `max_payment ≤ 0`) with `InvalidConfig` (30). The
   prompt asks for "a separate address"; this enforces it.
2. **Allowance and balance are checked before `transfer_from`.** If either
   is too low, the contract returns `AllowanceTooLow` (53) or `BalanceTooLow`
   (54). Without the check the failure would carry the USDC token's own
   error number, which overlaps this contract's (the token's 9, "allowance",
   would read as `ExpiryBeyondSenderTerm`). `transfer_from` still enforces
   both.
3. **An escrow records its `offer_id`.** The app links an accepted rental
   offer to its escrow ("offer accepted → escrow funded") from chain state
   alone.
4. **Views added** besides those in §10: `get_record_request`,
   `next_request_id`, `next_offer_id`, `next_escrow_id`. Requests, offers
   and escrows are enumerated like rights (`1..next_*`).
5. **Burning a rented-out right** fails with `NotHolder` (4), not
   `NotTitleHolder` as §3's table says. That is Phase 2's behaviour, unchanged:
   while the rental is live the renter is the effective holder, and that check
   comes first. The §3 table is corrected here rather than the code.
6. **Escrow TTL floor.** §9 says an escrow is extended to the ledgers until
   `check_in + 24 h + 30 days`, capped at the network maximum. Once that
   moment has passed, for example in a long dispute, the code still extends
   to at least 30 days (518,400 ledgers) on every touch, so a live escrow
   never runs down to zero.
7. **USDC sent to the contract directly.** The invariant holds for every
   contract call. A plain token transfer to the contract's address, outside
   QuietStay's functions, raises the balance above the escrow total, and no
   function can pay it out. Tested, and documented in DESIGN.md.
8. **The testnet fee route** now sponsors the one USDC call §13 names: an
   `approve` by the wallet, directly under a rights-contract call, with the
   rights contract as spender. Every other USDC call is still refused (tests
   in `src/lib/sponsor.test.ts`).
9. **Events** (all in `events.rs`): `rec_req`, `rec_cncl`, `sale_off`,
   `rent_off`, `off_cncl`, `allow`, `sale`, `funded`, `paid_out`, `refunded`,
   `dispute`, `evidence`, `resolve`. `accept_sale` and `accept_rental` also
   emit Phase 2's `transfer` event, so the existing transfer history keeps
   working.
10. **Proposed at the Step 3 deployment, awaiting approval: the allowance's
    expiration.** §4 says each offer call runs
    `usdc.approve(buyer, this, total, now + MAX_OFFER_LEDGERS)`. That cannot
    work on chain.
    - **Why:** the buyer signs the `approve` arguments, expiration included,
      when the call is simulated, and the transaction lands some ledgers later.
      By then `now + 120,960` is a different number, so the call no longer
      matches the signature.
    - **On testnet:** the first `create_rental_offer` on `CDC6XD3W…KMZO`
      failed with `Error(Auth, InvalidAction)`, tx `32ee3532…5f42`. Every
      offer call on that contract fails the same way.
    - **Proposed:** the expiration is the latest `expires_ledger` among the
      buyer's live offers, the new one included. On a cancel that leaves none,
      it is the cancelled offer's own last ledger, with amount 0. This depends
      only on signed arguments and stored state, is never later than
      `now + 120,960`, and still covers every live offer.
    - **A side effect, for the better:** an allowance now lapses with the
      buyer's last live offer. So D12's "leftover from offers that expired on
      their own" remains only while a later offer is still live, and nothing
      can be pulled from it either way.
    - **Edge case:** if one of the buyer's offers expires in the few ledgers
      between simulation and inclusion, the total changes and the call fails
      the same way. It is safe to send again.
    - **Tests:** `an_offer_signed_at_one_ledger_still_lands_ledgers_later`
      (fails with `Error(Auth, InvalidAction)` on the old rule, passes on the
      new) and `the_allowance_expires_with_the_last_live_offer`. Rights tests
      128/128.
    - **WASM:** 58,774 bytes, sha256 `c7473e8e…6b6b`. Not deployed.

## Decisions

Every decision approved so far, as recorded on 2026-11-19 (second review of
`def5eb6`). They are also recorded in `docs/PHASE3_PROGRESS.md` and not
reopened unless something breaks.

| # | Decision | Status | As approved |
| --- | --- | --- | --- |
| D1 | Account binding | **Approved** | Kind tag in `hi` (G = 0, C = 1); no circuit change. No range check confirmed; C-holder proof verified off-chain and on chain; contract-level test in Step 2. Stop if a circuit change turns out to be needed |
| D2 | GPL prover | **Approved** | One separately built GPL-3.0 worker, a `LICENSE` file in `prover-worker/`, an in-app license notice; `zk:check-bundle` enforces the boundary |
| D3 | First record delivery and backup | **Approved; amended 2026-11-25** | The sealed link (§2), no file, no backup export; the loss is a known limitation. Amended for issuance only: the issuer's browser may leave the record **sealed** with the owner's ask, for the owner's browser to pick up; the server keeps only that ciphertext, until pickup or 30 days (§2, "the issuance inbox") |
| D4 | Offers carry `h'` | **Approved with changes** | (1) the buyer receives and checks the sealed record against the current on-chain `C` **before** creating an offer; (2) the buyer's encryption-key hash is bound on chain and the seller's browser checks the link key against it before encrypting; (3) no analytics on the receiving page. See D4a for how (1) and (2) fit together |
| D5 | Three-step swap | **Approved** | §7, with no lock between accept and complete, withdrawal, and a full re-check at complete |
| D6 | Fees | **Approved with conditions** | §13. Testnet route: QuietStay calls and wallet deployment only, rate-limited, key with no other role. Mainnet: CLI script, auth-entry expiry ≈ 720 ledgers |
| D7 | Payment cap | **Approved with the change** | `max_payment` is a **constructor argument**, not a compiled constant, so the WASM hash is identical on both networks (§8). Mainnet 1 USDC, testnet 100 USDC; the 5 USDC total is checked by a script |
| D8 | Versions | **Approved** | §12 |
| D9 | Offer lifetime | **Approved** | 120,960 ledgers (~7 days) |
| D10 | Evidence on chain | **Approved** | In the escrow entry, ≤ 4 hashes per party, plus the decision hash, plus events |
| D11 | `transfer` and `burn` | **Approved with the change** | Keep both. `burn` is refused while the right is rented out, has a Funded or Disputed escrow, or has a pending swap acceptance, with tests for each (§3) |
| D12 | Allowance | **Approved** | Set by the offer calls themselves. The allowance equals the sum of the buyer's open offers. Leftover from offers that expired on their own cannot be pulled, documented in DESIGN.md. The Step 3 allowance tests apply to this model (§4) |
| D13 | Unpaid asks (Phase 2) | **Decided 2026-11-26** | Removed from the app's screens: a week is rented or bought only with a USDC offer (/stays). The contract is unchanged, and an ask made before can still be withdrawn on /list or answered on /transfer. The no-leak test now runs its sale and rental through USDC offers |
| D14 | Asking price | **Decided 2026-11-26** | A holder sets an asking price in USDC when listing, and can change it while listed. The contract's `Listing` has no price and stays unchanged, so the price is kept off chain beside the listing (`src/lib/asking-price.ts`, `/api/asking-price`). It is tied to the listing's `by` and `listed_at`, so it lapses when the listing is withdrawn or the week changes hands. It is capped at `max_payment` and binds nobody: the cards show it and the offer form on /stays starts from it, but the price paid is the one in the on-chain USDC offer the holder accepts |
| D15 | Command-line secret on /issue | **Decided 2026-11-26** | "Advanced: I made my secret with the command line" is removed from the Issue screen: a week asked for with an `h` from `npm run zk:secret` could never be rented out or sold from the browser, which no longer holds its secret. The browser makes and keeps the secret. A link printed by `npm run zk:secret` opens /issue with a note saying so. The API (`/api/requests/issuance`) and the scripts are unchanged |
| D16 | Owner's details on the issuance ask | **Decided 2026-11-26** | On /issue the owner enters their week's details (name, email, resort, town, country, unit, bedrooms, sleeps, features, dates, use year, deed, registry, recorded on, fees) with the ask, and the issuer's form starts filled in from them. The details are private, so they are sealed in the owner's browser to the issuer's *intake key*: an ECDH P-256 key made in the issuer's browser (private half non-extractable, in its vault) and published once with the issuer's SEP-53 signature through their wallet (`/api/issuer-key`). The owner's browser reads the issuer from the chain through the public RPC and checks the signature before sealing, so a server that swapped the key would be caught. The server stores only ciphertext (`sealed_details` on the ask). The issuer checks every field against the deed before issuing; the details only fill in the form. Details sealed to a key made in another browser cannot be opened there. The contract is unchanged |
| D17 | Renewing a week | **Decided 2026-11-27** | A right is one year's dates, fixed in its commitment, and the contract has no way to move them; only the issuer issues. So renewing is a new right the issuer issues, asked for by the week's title holder (checked on chain) from the record in their browser, with the same calendar dates a year later (amended 2026-11-27; it was 52 weeks later, which slipped the dates a day). **Manual**: the ask goes to the issuer at once. **Automatic, each year**: it is filed in advance and shown to the issuer only once the use year of the week it renews is over (amended 2026-11-27; it was the end of the week); once the new week is issued and in the owner's browser, the next year's is filed the same way. The issuer checks and issues every renewal. A week is renewed once, and by hand only from the day after its check-out, so renewals cannot run years ahead (amended 2026-11-27). A renewal carries the asking price for the new week, off chain, which fills its listing form; while it waits the owner can change the price or cancel it. A sale passes the week and its record, so the buyer renews it. A week issued before its use year begins has a validity window opening on the day of issue, so a renewal can be listed at once (the contract refuses listing outside the window). The contract is unchanged |
| D18 | Passkey fees on mainnet | **Decided 2026-11-27**, changes the 2026-11-23 plan (decision 4) | The CLI fee envelopes would make a passkey user wait for someone at a terminal. Instead the fee route (§13) runs on mainnet too, with a limited fee key the owner sets in Vercel as `QUIETSTAY_FEE_SECRET`, never in a file. The rules stay: QuietStay calls and passkey wallet creation only, the fee account in no argument or authorization, at most 1 XLM a transaction, the route refuses if the key is not `NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT`'s; mainnet limits are lower (10 per IP an hour, 10 per wallet and 50 in all a day). Against draining it (2026-11-28): a daily XLM budget, each fee counted at its cap before sending (mainnet 5 XLM, testnet 100), at most 0.5 XLM a transaction on mainnet, passkey wallet creation limited on its own (mainnet 2 per IP and 10 in all a day), and at most 6 listing changes, rental offers or record requests on one week a day on mainnet. A call the contract refuses fails its simulation and is never sent. The account holds only a few XLM; the issuer sees it and tops it up on the Wallet screen, or anyone sends it XLM. The issuer and arbiter keys stay out of the server in `cli` mode. Plan item 4 becomes this |

### D4a: approved (option 1), with three additions

The order of record delivery and offers: the on-chain
`request_record(buyer, right_id, key_hash, expires_ledger)` comes before the
offer.

- The seller's browser checks the link key against that entry before
  encrypting.
- The buyer checks the record against the current commitment, then creates
  the offer.
- The offer copies the key hash and consumes the request.

This keeps both intents: no payment is possible before the record is checked,
and the record is sealed only to a key bound to the buyer's account. The
additions, now in §2, §4, §7, §9 and §10:

1. **Swaps use the same request and sealed-record flow in both directions.**
   A swap can be completed only after both sides have checked the other's
   record. `offer_swap` requires the maker's request for `want_right`, and
   `accept_swap` requires the taker's request for `give_right`. Each side's
   app signs its next step only after its own check. Rentals do not use
   requests.
2. **Requests expire within the D9 limit** (≤ 120,960 ledgers) and are
   **capped at 10 live per requester**, tracked and pruned like offers.
3. **A request creates no obligation for the seller.** Nothing requires an
   answer, nothing has a deadline or a penalty, the right stays free for every
   other action, and an unanswered request simply expires.

The rejected alternative was an offer first, made acceptable only by a later
`mark_record_received`.

### Upstash store

**Confirmed by you on 2026-11-19 in the Vercel dashboard:** the store
`upstash-kv-cobalt-pillow` (Upstash for Redis) is connected to the project and
on the **Free** plan.

- The code uses it through `src/lib/kv.ts`, for the request store and the
  attestation store.
- Phase 3 adds only the fee route's rate-limit counters. They are small
  counters with short expiries, well inside the free tier; VERCEL.md already
  says the free tier is far more than this app uses.
- This needs no new infrastructure.

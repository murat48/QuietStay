# Issuer attestations: schema, signing key, and verification procedure

An attestation is the issuer saying, in a form anyone can check: *this usage right
is a real week, it carries no unpaid maintenance fees, and this is the place it
gets you.*

Under Phase 2 it is the one thing that still rests on trusting the issuer — and it
**decides nothing**. No transfer depends on it: the contract authorizes transfers
by the holder's ownership proof ([CIRCUIT.md](./CIRCUIT.md)), so an issuer that
withholds an attestation, or signs a bad one, cannot freeze a week. It is there for
a buyer to read. Verifying it proves the issuer **said** something, not that the
issuer was honest — see [DESIGN.md](./DESIGN.md#the-trust-model-phase-1-and-phase-2).

This document describes schema **v2**, used on the Phase 2 contract. v1, which
bound the on-chain commitment instead, is described at the
[last Phase 1 commit](https://github.com/murat48/QuietStay/blob/a1b8ad2edf2953dac7216d36a49d2fb56c47b4b8/docs/ATTESTATION.md).

---

## What it does not say

An attestation does **not** say who holds the right. That is `holder(right_id)` on
the contract, which the issuer cannot influence, plus SEP-10 proof that the seller
controls that account. An attestation stays valid after the week changes hands,
because it was never about the holder.

## Signing key

The issuer's **Stellar account key** — the key the contract records as `issuer()`.
A verifier reads the issuer address **from the contract**, never from the
attestation; `payload.issuer` and `signature.key` are checked *against* `issuer()`.

## Signing input

Ed25519 over UTF-8 bytes, via `Keypair.sign` / `Keypair.verify` from
`@stellar/stellar-sdk` — the primitive that signs every Stellar transaction. No
cryptography is implemented in this project.

```
signing input = "QuietStay-Attestation-v2:" || canonical(payload)
```

`canonical` is [RFC 8785 as specified for commitments](./COMMITMENT.md). The prefix
is domain separation, and its version changed with the schema, so a v1 signature
can never be read as a v2 one. See [`src/lib/attestation.ts`](../src/lib/attestation.ts).

## Schema

`quietstay.attestation.v2` — sample week 01 on the Phase 2 contract, as committed
in [`inventory/phase2/attestations/right-1.attestation.json`](../inventory/phase2/attestations/right-1.attestation.json):

```json
{
  "payload": {
    "schema": "quietstay.attestation.v2",
    "network": "Test SDF Network ; September 2015",
    "contract": "CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD",
    "right_id": 1,
    "record_digest": "e8ad1bb9deff0137565e22278ed2e42d9b894b442930bf03b9db050e98b0d991",
    "issuer": "GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE",
    "week_valid": true,
    "property": {
      "region": "Lagos, Portugal",
      "bedrooms": 2,
      "sleeps": 4,
      "features": ["sea view", "pool", "wifi"]
    },
    "maintenance_fees_current": true,
    "fees_paid_through": "2026-12-31",
    "issued_at": "2026-10-09T11:46:50.553Z",
    "not_before": "2026-10-09T11:46:50.553Z",
    "expires_at": "2027-10-09T11:46:50.553Z"
  },
  "signature": {
    "alg": "ed25519",
    "key": "GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE",
    "value": "base64…"
  }
}
```

| Field | Meaning |
| --- | --- |
| `network` | Network passphrase this attestation is valid on. |
| `contract` | The deployment it refers to. |
| `right_id` | The specific right. |
| `record_digest` | `d`: the off-chain record's SHA-256, lowercase hex — what `sha256sum` gives for its canonical form. |
| `issuer` | The issuer's account, which is also the signing key. |
| `week_valid` | The issuer asserts this is a real, allocated interval. |
| `property` | What the listing may publish about the place. Optional — see below. |
| `maintenance_fees_current` | The issuer asserts no fees are outstanding. |
| `fees_paid_through` | ISO date fees are settled through. |
| `not_before` / `expires_at` | When the attestation may be relied on. |

### Why `d`, and not the on-chain commitment

v1 bound `commitment`, which was then `d` itself. Under Phase 2 the ledger holds
`C = Poseidon(d, holder, h)` (docs/CIRCUIT.md §2): it changes on every sale, and
nobody can recompute it without the holder's secret hash `h` and Poseidon. An
attestation bound to `C` would go stale at the first sale and could not be checked
in a browser at all. `d` never changes — the record does not — so v2 binds `d`, and
the step from `d` to the ledger's `C` belongs to the command line
([below](#verification-procedure)).

### Binding — why one attestation cannot be presented for another week

Four signed fields tie an attestation to exactly one thing:

- `record_digest` — cannot be lifted onto a different record;
- `right_id` — cannot be lifted onto a different week;
- `contract` — cannot be lifted onto another deployment, including the Phase 1 one
  whose rights carry the same numbers;
- `network` — cannot be lifted from testnet onto mainnet.

Altering any of them breaks the signature. A verifier checks `right_id`, `contract`
and `network` against what it is actually looking at, and `record_digest` against
the record it was shown.

### Why the property description is in here

A commitment covers the whole record, so no single field can be revealed and checked
on its own: to verify a week is in Portugal you would have to be given the deed, the
unit and the owner's name as well. Selective disclosure — proving one field against
the ledger — is out of scope for Phase 2. So the description rides in the
attestation, signed and bound to one right, with the same standing as the fee claim.

**Where the line falls.** `region` is the town and the country and stops there: a
town shares its name with thousands of owners, whereas the resort plus the unit
names one apartment. `bedrooms`, `sleeps` and `features` say what the place *is*,
which identifies nobody. The resort, the unit, the deed and the owner stay in the
record, disclosed once, to a counterparty.

`npm run attest` derives the block from the record. `--region`, `--sleeps` and
`--features` override it, and the script warns every time: an override is the
issuer's word alone. The four sample records predate those fields, so their Phase 2
attestations carry the descriptions Phase 1 published for the same weeks.
`npm run describe` restates an existing attestation's description when the record is
gone; it refuses unless the attestation on file is the issuer's own for that right on
that contract.

## Verification procedure

Implemented in [`verifyAttestation`](../src/lib/attestation.ts), run in the
counterparty's browser on the verify screen and by `npm run verify-record`, and
reported check by check.

Given a right id, an attestation, and optionally the disclosed record:

| # | Check | Compared against |
| --- | --- | --- |
| 1 | `schema` is `quietstay.attestation.v2` | — |
| 2 | `network` matches the network you are on | The verifier's own configuration |
| 3 | `contract` matches the contract you are reading | The verifier's own configuration |
| 4 | `right_id` matches the right you are looking at | The right you asked about |
| 5 | `payload.issuer` and `signature.key` both equal `issuer()` | **Read from the contract** |
| 6 | Ed25519 signature verifies over the signing input | `signature.key` |
| 7 | `record_digest` equals SHA-256 of the disclosed record | **Computed by the verifier**, if a record was supplied |
| 8 | Now is within `not_before` … `expires_at` | The verifier's clock |
| 9 | `week_valid` is `true` | — |
| 10 | `maintenance_fees_current` is `true` | — |

Check 5 is what makes this more than self-assertion: a forger needs the issuer's
key. Check 7 runs in the browser — `d` is WebCrypto SHA-256 over the canonical
record.

**And the last link, in the command line.** That the record is the one inside the
ledger's commitment takes Poseidon and the holder's `h` (disclosed with the record;
never the secret `s`):

```bash
npm run verify-record -- <right_id> <attestation.json> <record.json> --secret-hash <h>
#  ✓ The record and h give the commitment the ledger holds
```

It recomputes `C = Poseidon(d, title holder, h)` and compares it with
`commitment(right_id)`. Poseidon runs only in the circuit and the command-line
tools, never in a browser, which is why this check is here and not on the verify
screen. The screen says so in one sentence.

## When the issuer says a week is not clean

Sample week 04 carries €410 outstanding, so its attestation says
`maintenance_fees_current: false`. A counterparty verifying right #4 sees check 10
fail, with the reason, and the registry marks the week.

What it does **not** do, under Phase 2: stop a transfer. The holder can still rent
the week out or sell it; a buyer simply knows what is owed. An attestation that could
stop a transfer would hand the issuer back the power to freeze a week, which is what
Phase 2 took away.

## Sample attestations

[`inventory/phase2/attestations/`](../inventory/phase2/attestations/) — one per
sample week on the Phase 2 contract, including the un-clean week 04. Rights issued
through the issue screen go to the deployment's store (a key-value store on a
serverless host, keyed by contract, or this folder locally).

```bash
# with no document disclosed at all — attestation plus the contract
npm run verify-record -- 3 inventory/phase2/attestations/right-3.attestation.json

# the record too, checked against what the issuer attested
npm run verify-record -- 3 inventory/phase2/attestations/right-3.attestation.json \
  inventory/records/week-03.json

# and against the ledger's commitment, with the holder's h
npm run verify-record -- 3 inventory/phase2/attestations/right-3.attestation.json \
  inventory/records/week-03.json --secret-hash <h>
```

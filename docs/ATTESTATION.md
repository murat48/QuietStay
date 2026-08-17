# Issuer attestations: schema, signing key, and verification procedure

An attestation is the issuer saying, in a form anyone can check: *this usage right
is a real week, and it carries no unpaid maintenance fees.*

It is the one place Phase 1 rests on trusting the issuer, and it does so
explicitly. Verifying an attestation proves the issuer **said** something. It does
not prove the issuer was honest — see
[DESIGN.md § the issuer still can](./DESIGN.md#the-issuer-still-can).

---

## What it does not say

An attestation does **not** say who holds the right. That question is answered by
`holder(right_id)` on the contract, which the issuer cannot influence, plus SEP-10
proof that the seller controls that account.

This matters practically: an attestation stays valid after the week changes hands,
because it was never about the holder. A buyer verifies the attestation *and*
separately checks the contract's holder. The issuer cannot make someone look like a
holder by signing something.

## Signing key

The issuer's **Stellar account key** — the same key the contract records as
`issuer()`. There is no separate attestation key, and no key hierarchy.

A verifier must read the issuer address **from the contract**, not from the
attestation. An attestation naming its own signer as the issuer proves nothing;
`payload.issuer` and `signature.key` are checked *against* `issuer()` and are
otherwise untrusted input.

## Signing input

Ed25519 over UTF-8 bytes, via `Keypair.sign` / `Keypair.verify` from
`@stellar/stellar-sdk` — the same primitive that signs every Stellar transaction.
No cryptography is implemented in this project.

```
signing input = "QuietStay-Attestation-v1:" || canonical(payload)
```

`canonical` is [RFC 8785 as specified for commitments](./COMMITMENT.md). The prefix
is domain separation: it makes the signed bytes unmistakably an attestation and not
a transaction envelope or any other payload the same key might sign. The signature
is base64 in the envelope.

See [`src/lib/attestation.ts`](../src/lib/attestation.ts).

## Schema

`quietstay.attestation.v1`:

```json
{
  "payload": {
    "schema": "quietstay.attestation.v1",
    "network": "Test SDF Network ; September 2015",
    "contract": "CDBPK4OOM43UCROSEDC2Q5NHR6L7GBKLESXP4GXXN4KHNL25FTM3DBXS",
    "right_id": 1,
    "commitment": "e8ad1bb9deff0137565e22278ed2e42d9b894b442930bf03b9db050e98b0d991",
    "issuer": "GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE",
    "week_valid": true,
    "maintenance_fees_current": true,
    "fees_paid_through": "2026-12-31",
    "issued_at": "2026-08-13T12:53:04.000Z",
    "not_before": "2026-08-13T12:53:04.000Z",
    "expires_at": "2027-08-13T12:53:04.000Z"
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
| `commitment` | The specific off-chain record, as lowercase hex SHA-256. |
| `issuer` | The issuer's account, which is also the signing key. |
| `week_valid` | The issuer asserts this is a real, allocated interval. |
| `maintenance_fees_current` | The issuer asserts no fees are outstanding. |
| `fees_paid_through` | ISO date fees are settled through. |
| `not_before` / `expires_at` | When the attestation may be relied on. |

### Binding — why one attestation cannot be presented for another week

Four fields tie an attestation to exactly one thing, and a verifier checks all four
against what the contract actually says:

- `right_id` — cannot be lifted onto a different week;
- `commitment` — cannot be lifted onto a different record for the same week;
- `contract` — cannot be lifted onto another deployment;
- `network` — cannot be lifted from testnet onto mainnet.

Any of them altered breaks the signature, because all four are inside the signed
payload.

## Verification procedure

Implemented in [`verifyAttestation`](../src/lib/attestation.ts), run in the
counterparty's browser on the verify screen, and reported check by check so a
failure says *which* leg failed rather than just that something did.

Given a right id, an attestation, and optionally the disclosed record:

| # | Check | Compared against |
| --- | --- | --- |
| 1 | `schema` is `quietstay.attestation.v1` | — |
| 2 | `network` matches the network you are on | The verifier's own configuration |
| 3 | `contract` matches the contract you are reading | The verifier's own configuration |
| 4 | `right_id` matches the right you are looking at | The right you asked about |
| 5 | `payload.issuer` and `signature.key` both equal `issuer()` | **Read from the contract** |
| 6 | Ed25519 signature verifies over the signing input | `signature.key` |
| 7 | `commitment` equals `commitment(right_id)` | **Read from the contract** |
| 8 | The disclosed record hashes to `commitment(right_id)` | Recomputed locally, if a record was supplied |
| 9 | Now is within `not_before` … `expires_at` | The verifier's clock |
| 10 | `week_valid` is `true` | — |
| 11 | `maintenance_fees_current` is `true` | — |

Checks 5 and 7 are the ones that make this more than self-assertion: both compare
the attestation against the contract, so an attacker who forges an attestation must
also have the issuer's key *and* must match a commitment already on chain.

The verify screen adds two further checks that are about the right rather than the
attestation: that the account offering the week is the holder the contract names,
and that the right is inside its validity window and not already rented out.

## When the issuer declines to attest

An issuer that cannot vouch for a week should not sign that it can. Sample week 04
carries €410 outstanding, so its attestation is written with
`maintenance_fees_current: false`. It is a real, correctly signed attestation that
says the week is **not** clean.

Two things follow, both deliberate:

- A counterparty who verifies right #4 sees check 11 fail, with the reason.
- The approval service declines to approve a transfer of it, naming the failed
  check. The holder keeps the week — declining is not seizing — but cannot transfer
  it through this deployment while the arrears stand.

## Sample attestations

- [`inventory/attestations/`](../inventory/attestations/) — one per issued right,
  including the un-clean week 04. Rights created later through the issue screen or by
  `npm run e2e` land here too, since they go through the same code path.
- [`inventory/evidence/attestations/`](../inventory/evidence/attestations/) — the
  disposable weeks issued by `npm run evidence`.

See [`inventory/README.md`](../inventory/README.md) for what is in each directory.

To verify one from the command line:

```bash
# with no document disclosed at all — attestation plus the contract is enough
npm run verify-record -- 1 inventory/attestations/right-1.attestation.json

# and, if the seller also showed you the record, to check that too
npm run verify-record -- 1 inventory/attestations/right-1.attestation.json \
  inventory/records/week-01.json
```

# The commitment: canonical serialization specification

A hash commitment is worth nothing if two parties cannot independently compute the
same bytes from the same record. This document pins the encoding precisely enough
that a reviewer can recompute a commitment from an off-chain record and get a match
— using nothing but `sha256sum`.

---

## Definition

```
canonical bytes = UTF-8 encoding of RFC 8785 (JCS) serialization of the record
commitment      = SHA-256(canonical bytes)
```

The commitment is stored on chain as a `BytesN<32>` and written in documentation as
64 lowercase hex characters.

## Why RFC 8785

`JSON.stringify` is not a specification. Key order, number formatting, and string
escaping all vary between implementations and even between runs. **RFC 8785**, the
JSON Canonicalization Scheme, fixes exactly the three things that drift:

1. **Object keys** are sorted by UTF-16 code unit.
2. **Numbers** use the ECMAScript `Number::toString` form.
3. **Strings** use the shortest legal escaping.

QuietStay does not implement JCS. It uses the [`canonicalize`](https://www.npmjs.com/package/canonicalize)
package, in keeping with the rule that no cryptographic or encoding primitive is
hand-rolled here. SHA-256 comes from WebCrypto — the same primitive in Node and in
the browser, so the verify screen hashes on the counterparty's own machine rather
than trusting a server to do it.

See [`src/lib/canonical.ts`](../src/lib/canonical.ts).

## Two rules that trip people up

**No trailing newline.** The canonical form ends with `}`. Canonical files written
to `inventory/canonical/` deliberately have no final newline, because one would
change the hash. Most editors add one on save; if you edit such a file, the hash
will stop matching and the file is no longer canonical.

**Hash the canonical file, not the source record.** `inventory/records/week-01.json`
is pretty-printed for humans and does **not** hash to the commitment.
`inventory/canonical/week-01.canonical.json` does.

## Record schema

`quietstay.ownership-record.v1`. Every field is committed; none of it reaches the
ledger. Validated by [`validateRecord`](../src/lib/record.ts) before anything is
hashed, because a malformed record is one whose commitment can never be reproduced.

```jsonc
{
  "schema": "quietstay.ownership-record.v1",
  "record_id": "7d659ea0-dccd-4643-bef2-c800957a58bd",  // unique per record
  "salt": "a65572ff…4536",                              // 64 lowercase hex = 32 bytes
  "owner": {
    "name": "Ayla Demir",
    "email": "ayla.demir@example.invalid",
    "stellar_account": "GBCETLZR…4AYR"                  // holds the right on chain
  },
  "resort": {
    "name": "Cliffside Bay Club",
    "country": "Portugal",
    "unit": "Villa 14B",
    "bedrooms": 2
  },
  "week": {
    "check_in": "2026-10-03",                           // ISO date, first night
    "check_out": "2026-10-10",                          // ISO date, departure
    "use_year": 2026,
    "week_number": 40
  },
  "title": {
    "deed_reference": "CBC-2019-04471",
    "registry": "Cliffside Bay Club Members Registry",
    "recorded_on": "2019-03-22"
  },
  "maintenance_fees": {
    "annual_amount": "820.00",
    "currency": "EUR",
    "paid_through": "2026-12-31",
    "outstanding": "0.00"                               // "0.00" means the week is clean
  }
}
```

### The two fields that exist for the commitment's sake

**`salt`** — 32 random bytes. The rest of a record is low entropy: a date range, a
resort from a short list, a name. Without a salt, anyone could confirm a guess by
hashing it, and the commitment would be reversible by brute force rather than
revealing nothing. Generate it with `openssl rand -hex 32`, once per record, and
never reuse one.

**`record_id`** — makes each record unique so that one document cannot be committed
for two different rights and presented interchangeably.

### Derived on-chain windows

The contract needs two windows, and both are computed from the record rather than
supplied separately, so they cannot disagree with it
([`onChainWindows`](../src/lib/record.ts)):

| On chain | Derived from |
| --- | --- |
| `period.start` / `period.end` | `week.check_in` / `week.check_out`, as Unix seconds |
| `validity.from` / `validity.until` | `use_year`-01-01 to `use_year + 1`-01-01 |

The contract requires `validity.from <= period.start` and
`period.end <= validity.until`, so a record whose week falls outside its use year is
rejected at issuance (`InvalidValidity`) — and `validateRecord` rejects it earlier
with a message that says why.

## Reproducing a commitment

```bash
npm run commit-record -- inventory/records/week-01.json
```

Which prints the commitment and writes the canonical bytes. Then verify it with a
tool that has never heard of this project:

```bash
$ sha256sum inventory/canonical/week-01.canonical.json
e8ad1bb9deff0137565e22278ed2e42d9b894b442930bf03b9db050e98b0d991  inventory/canonical/week-01.canonical.json
```

And compare against what the ledger holds:

```bash
$ stellar contract invoke --id <CONTRACT_ID> --source <any-identity> \
    --network testnet --send=no -- commitment --right_id 1
"e8ad1bb9deff0137565e22278ed2e42d9b894b442930bf03b9db050e98b0d991"
```

Three independent computations of the same value: this project's tooling,
`sha256sum`, and the deployed contract. The current values for every sample week
are in [`inventory/issued.json`](../inventory/issued.json).

## Verifying without any tooling at all

The verify screen does the same thing in a browser, and shows its working:
canonicalize the pasted record, hash it with WebCrypto, compare against
`commitment(right_id)` read from the contract. It involves no server that could lie
about the result.

Note that this step is **optional** for a counterparty. An issuer-signed attestation
plus the contract already establishes that a week is real, owes nothing, and is held
by a particular account — with no document disclosed at all. Recomputing a commitment
is the deeper check available when a seller does choose to show the underlying
record. See [DESIGN.md](./DESIGN.md#why-the-document-is-optional).

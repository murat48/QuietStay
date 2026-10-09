# Sample inventory

Everything a reviewer needs to reproduce a commitment and verify an attestation by
hand.

**The records here are fictional.** Names, resorts, unit numbers, deed references,
and fee figures were invented for the demo. In a real deployment these files would
never leave the parties holding them — they are published here only so that
commitments can be checked independently.

**Phase 2.** The same four records are issued on the Phase 2 contract with
Poseidon commitments; [`phase2/issued.json`](./phase2/issued.json) lists each
week's right id, its SHA-256 digest `d` — still what `sha256sum` gives for the
canonical file below — and its on-chain commitment `C`. How `d` becomes `C` is in
[COMMITMENT.md](../docs/COMMITMENT.md#phase-2-the-ledger-stores-c-which-wraps-this-digest).
`phase2/attestations/` holds the v2 attestations the live app reads. The rest of
the files below describe the Phase 1 contract, as delivered.

## What is in each directory

| Path | Contents |
| --- | --- |
| `records/` | The four sample ownership records, pretty-printed for reading. **These do not hash to the commitment** — see below. |
| `canonical/` | The RFC 8785 canonical form of each record, with no trailing newline. `sha256sum` on one of these gives the value on chain. |
| `phase2/issued.json` | **Phase 2**: each sample week's right id, `d`, on-chain commitment `C`, and issuance transaction on the Phase 2 contract. |
| `phase2/attestations/` | **Phase 2**: v2 attestations, bound to `d`, the right and the contract. |
| `attestations/` | Phase 1: v1 attestations for the Phase 1 contract. |
| `evidence/` | Phase 1: the throwaway weeks its evidence run issued. |
| `issued.json` | Phase 1: each sample right id, its record, commitment, attestation, and issuance transaction. |

## The four sample weeks

| Right | Week | Attested clean |
| --- | --- | --- |
| #1 | 2026-10-03 → 2026-10-10 | yes |
| #2 | 2026-09-05 → 2026-09-12 | yes |
| #3 | 2026-11-21 → 2026-11-28 | yes |
| #4 | 2026-12-19 → 2026-12-26 | **no — €410 outstanding** |

Week 04 is deliberately not clean. The issuer signs a real, valid attestation that
says `maintenance_fees_current: false`, so the verify screen fails on exactly that
check and the approval service declines to approve a transfer of it. The holder keeps
the week — declining is not seizing.

Use #3 for a demo that verifies, and #4 for one that correctly refuses.

## Checking a commitment yourself

```bash
$ sha256sum canonical/week-03.canonical.json
d1e56562ea6f41073e50158da2cb122df01e7f6aee3ab7845669f0955f5ffc4c  canonical/week-03.canonical.json
```

Compare against `issued.json`, and against the contract itself:

```bash
stellar contract invoke --id <CONTRACT_ID> --source <identity> --network testnet \
  --send=no -- commitment --right_id 3
```

Three independent computations of the same 32 bytes. Full specification in
[../docs/COMMITMENT.md](../docs/COMMITMENT.md).

**Do not reformat the canonical files.** They end with `}` and no newline. Most
editors add one on save, which changes the hash and makes the file non-canonical.
Regenerate with `npm run commit-record -- records/week-03.json` if that happens.

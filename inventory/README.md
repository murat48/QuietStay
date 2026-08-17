# Sample inventory

Everything a reviewer needs to reproduce a commitment and verify an attestation by
hand.

**The records here are fictional.** Names, resorts, unit numbers, deed references,
and fee figures were invented for the demo. In a real deployment these files would
never leave the parties holding them — they are published here only so that
commitments can be checked independently.

## What is in each directory

| Path | Contents |
| --- | --- |
| `records/` | The four sample ownership records, pretty-printed for reading. **These do not hash to the commitment** — see below. |
| `canonical/` | The RFC 8785 canonical form of each record, with no trailing newline. `sha256sum` on one of these gives the value on chain. |
| `attestations/` | Issuer-signed attestations, one per issued right — including rights created later through the app's issue screen or by `npm run e2e`, since those go through the same code path. |
| `evidence/` | Throwaway records and attestations issued by `npm run evidence`. Kept separate because each evidence run issues its own weeks. |
| `issued.json` | Maps each sample right id to its record, canonical file, commitment, attestation, and issuance transaction. |

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

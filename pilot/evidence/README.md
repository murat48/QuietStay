# Pilot evidence files

Sample files for the disputed-rental flows (docs/PHASE3_SPEC.md §6). The app
hashes a chosen file in the browser with SHA-256 and sends only the hash; the
file itself is never uploaded. These samples are committed so anyone can
recompute every on-chain hash:

    sha256sum pilot/evidence/*.txt

| File | Submitted by | As |
| --- | --- | --- |
| `problem-report.txt` | the renter | `report_problem` (the escrow becomes Disputed) |
| `renter-evidence-1.txt` | the renter | `submit_evidence` |
| `owner-evidence-1.txt` | the owner | `submit_evidence` |
| `arbiter-decision.txt` | the arbiter | `resolve` (`scripts/arbiter-resolve.sh --decision`) |

They are sample text for a controlled pilot between builder-controlled
accounts: no personal data, no real resort, no real stay. Which transaction
carried which hash is recorded in docs/PHASE3_PROGRESS.md and, from Step 7,
docs/EVIDENCE.md.

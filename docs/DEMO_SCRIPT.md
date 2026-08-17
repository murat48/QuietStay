# Demo video script — ~2 minutes

A shot list and narration for the end-to-end recording. Target 1:50–2:10.

**Before recording:** `npm run build && npm run start`, Freighter on testnet, three
browser tabs ready (list / verify / transfer), and a terminal. Have
`inventory/records/week-03.json` and `inventory/attestations/right-3.attestation.json`
open in an editor to copy from.

The one thing that must land: **the buyer verifies without trusting the app, and the
contract refuses an unapproved transfer.** If time runs short, cut the issue screen,
not the refusal.

---

## 0:00–0:15 — The problem

> "A timeshare owner who can't travel this year has no simple way to pass the week
> on. And a buyer can't check who really holds it, or whether it owes maintenance
> fees. Put it on a public ledger and you fix that — but now everyone can see the
> owner's travel plans."

**Screen:** the home page.

## 0:15–0:35 — What's actually on chain

> "QuietStay keeps the ownership record off chain. The ledger holds a SHA-256 hash of
> it, and nothing else about it."

**Screen:** the **list** screen. Point at right #3 — the week dates, the commitment
hash, the holder address.

> "The week's dates are public, because an offer has to say what it's offering. The
> owner's name, the resort, the unit, the deed — none of that is here. Just the hash."

## 0:35–1:05 — Verification (the core)

**Screen:** the **verify** screen, right #3 loaded.

> "Here's the buyer's side. The seller has privately sent them two files: the
> ownership record, and the issuer's attestation."

Paste `week-03.json`, then `right-3.attestation.json`. Click **Verify**.

> "Everything you're seeing is computed in this browser. The record is hashed here
> and matched against the hash on chain — so it's the record that was committed, and
> it hasn't been edited since. The issuer's signature is checked against the issuer
> address read from the contract, not from the file. And the contract itself says who
> holds the week."

**Screen:** the green checklist. Let it sit for a beat.

> "Now the buyer knows the seller really holds it and the week is clean — and no
> document, no name, no resort ever touched the public ledger."

## 1:05–1:20 — A week that fails

**Screen:** switch to right **#4**, paste `week-04.json` and its attestation, verify.

> "And when something's wrong, you see which thing. This week carries four hundred
> and ten euros in unpaid fees, so the issuer won't attest that it's clean. One check
> fails, and it says why."

**Screen:** the single red line on the fees check.

## 1:20–1:45 — Transfer, both modes

**Screen:** the **transfer** screen.

> "Renting and selling are the same contract call. One primitive with a duration."

Select a week, choose **Rent**, set a date, enter the recipient, click through.

> "A rental carries an expiry. Title stays with the owner, and the week comes back on
> its own when the term ends — there's no return transaction to send, and no way to
> forget."

**Screen:** the confirmation with the transaction link. Then flip the radio to
**Sell**.

> "Selling is the same call with no expiry. That's the entire difference."

## 1:45–2:05 — The refusal

> "The issuer approves transfers the holder starts. So — what if you skip the
> approval?"

**Screen:** click **Try it without issuer approval**. Sign in Freighter. Wait for it.

> "Signed by the holder, paid for, submitted. And rejected — by the contract, not by
> this interface."

**Screen:** open the transaction in stellar.expert.

> "There it is on chain. Two account addresses, a right id, and a hash. The issuer
> can approve a transfer or decline it. What it can't do is move a week that someone
> already holds — and that's not a promise, it's in the contract."

## Optional tail, if under time

> "Phase 1 trusts the issuer to attest honestly, and says so. Replacing that
> signature with a cryptographic proof is Phase 2."

---

## Alternative: the issuer's seizure attempt

If the live click-through is unreliable on the day, substitute a terminal shot:

```bash
npm run evidence
```

and narrate the four results — rental, sale, unapproved transfer rejected, issuer
seizure rejected — then open the last hash in the explorer. Less immediate than
clicking, but it shows all four outcomes in one pass and cannot fail on camera.

## Publishing checklist

- [ ] ~2 minutes, 1080p or better, readable text at 100% browser zoom
- [ ] The verify checklist is legible in full, without pausing
- [ ] At least one real transaction opened in stellar.expert on camera
- [ ] No secret key, `.env.local`, or seed phrase ever on screen
- [ ] Link added to [EVIDENCE.md](./EVIDENCE.md) and the [README](../README.md)

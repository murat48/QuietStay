# One passkey approval on your own device (Step 2)

Every passkey test so far used Chromium's virtual authenticator: a real
WebAuthn credential and signature, but no person and no physical
authenticator. This step is the same flow with your own platform passkey
(Windows Hello, or Google Password Manager in Chrome). It ends in a contract
call that your smart wallet authorizes with that passkey.

It runs the app locally against the **Step 2 staging contract**
`CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5`. That is the
deployment that accepts smart-wallet holders, and its issuer is `qs-issuer`,
the key in your `.env.local`. Nothing touches mainnet. Fees are paid by
`qs-fee-testnet` through `/api/tx/sponsor`, using
`QUIETSTAY_TESTNET_FEE_SECRET` from your `.env.local`.

Time: about 10 minutes.

## 1. Start the app

From the repository, on branch `phase3`:

```bash
npm ci
npm run zk:build-worker
QUIETSTAY_CONTRACT_ID=CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5 \
NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5 \
QUIETSTAY_DATA_DIR="$(mktemp -d)" \
npx next dev --webpack -p 3000
```

The variables on the command line take precedence over `.env.local`, and
`.env.local` itself is not changed. `--webpack`: Turbopack cannot fetch the
Google fonts on this machine (a known Low issue).

## 2. Create the passkey wallet (two passkey prompts)

1. Open **http://localhost:3000/list** in desktop **Chrome**. On Windows with
   WSL2, Chrome on Windows reaches `localhost:3000` directly.
2. Top right: **Use a passkey** → **Create a passkey wallet**.
3. The first prompt creates the passkey. `/api/tx/sponsor` then pays for the
   wallet's creation on testnet.
4. The second prompt signs you in (SEP-45).
5. The header now shows `🔑 C…`. Hover over it for the full address, and copy
   it.

If the browser says passkeys are unavailable, the message points to the
regular wallet. Tell me which browser and device it was.

## 3. Give the wallet a week (terminal)

```bash
QUIETSTAY_CONTRACT_ID=CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5 \
NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5 \
npm run zk:issue -- --contract CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5 \
  --owner <your C… address> --check-in 2026-12-19 --check-out 2026-12-26
```

This issues one week to the wallet, signed by the issuer key in `.env.local`.
The record and its secret go to `.secrets/` (gitignored). Offering a week
needs only the holder's authorization, not a proof, so the secret staying on
the command line does not matter for this step.

## 4. The passkey approval

1. Reload **http://localhost:3000/list**. Click **Sign in** if the header asks;
   that is a passkey prompt.
2. On your week's card, click **Offer for rent — …**.
3. Approve with your passkey. That prompt is the approval: your smart wallet
   authorizes `list` on the rights contract.
4. The page shows "Offer published for right #N — <hash>". Copy the hash.

## 5. Send me the hash

Send me the transaction hash, the device, the OS, the browser, and which
passkey (Windows Hello, a phone, Google Password Manager). I will check the
transaction on chain, run `check-privacy` on it into `evidence/privacy/`, and
record it in the progress log. To run the check yourself:

```bash
npm run check-privacy -- --network testnet --tx device-passkey-list=<hash> \
  --out evidence/privacy/$(date +%F)-device-passkey.txt
```

**What it shows on chain:** the transaction's source is `qs-fee-testnet`
(`GCGDZWCL…L77Z`), which only pays. The one authorization is your `C…`
wallet's, with an External signer on the OpenZeppelin WebAuthn verifier
`CC7EKIH…OM3F`.

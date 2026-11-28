# Deploying to Vercel

There are two ways to run this, and the difference is whether the deployment can
act as the issuer. Both are supported; pick deliberately, because one of them
puts a key on a host that can never be taken back.

| | Showcase | Full |
| --- | --- | --- |
| Browse, verify, sign in, list/unlist | ✅ | ✅ |
| Ask for a week | needs a store | ✅ |
| Rent out or sell a week (by proof) | ✅ | ✅ |
| Issue, settle fees | ✗ | ✅ |
| `QUIETSTAY_ISSUER_SECRET` on the host | no | **yes** |
| Where weeks are issued | locally, then git | in the app |

## Moving the live app to Phase 2

The app reads its contract from `NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID` (and
`QUIETSTAY_CONTRACT_ID`), falling back to the Phase 2 deployment,
`CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD`, built into
`src/lib/config.ts`. A `NEXT_PUBLIC_` value is baked in at build time, so if the
Vercel project sets either variable to the Phase 1 contract, change both to the
Phase 2 address — or delete them to take the default — and **redeploy**.

Nothing else needs migrating. The store's keys now carry the contract address
(`quietstay:<contract>:attestation:<id>`), so Phase 1 entries are simply not read;
the Phase 2 attestations ship with the build from
`inventory/phase2/attestations/`.

## The one thing to understand before choosing

`QUIETSTAY_ISSUER_SECRET` issues weeks and signs every attestation — under Phase 2
it authorizes no transfer — and unlike the other two secrets it **cannot be rotated** — the contract fixed
its issuer at construction. Replacing it means a new contract, a new address, and
every hash in [EVIDENCE.md](./EVIDENCE.md) pointing at a deployment nobody uses.
A key that leaks is leaked for the life of the deployment.

What it cannot do is worth stating just as plainly, because it is the project's
own claim being cashed: **even a host compromised completely could not take a
week.** `transfer` begins with `from.require_auth()`, and no server-side key
satisfies that — only the holder's wallet does. The worst a stolen issuer key can
do is **lie**: sign attestations for weeks that do not deserve them, which under
Phase 2 misleads a buyer but cannot stop or force a transfer.

The other two secrets are rotatable and belong on the host either way. A forged
session convinces the app you are someone else, and then `transfer` asks for the
holder's wallet signature and gets nothing. Nothing moves.

## Showcase: attestations reach the host through git

The issuer's key stays where it already lives — a laptop, not a host — and the
server only ever **reads** what it signed:

```
1. issue a week locally          the key never leaves
2. inventory/phase2/attestations/  the signed file appears
3. git commit && git push
4. Vercel rebuilds               the registry shows it
```

Next's build traces `inventory/phase2/attestations` into the serverless functions, so
the files are present at runtime. Committing them is what makes that work —
**an attestation that is not in git does not exist as far as Vercel is
concerned**, and its week shows as never attested, which also keeps it out of
the "For rent" and "For sale" filters.

## Full: the app issues, and needs somewhere to put the result

Set `QUIETSTAY_ISSUER_SECRET` **and** a store. Both, or neither — see
[the store section](#the-store-and-why-the-app-needs-one) for why the key alone
is the one combination that actively breaks things.

The git route above still works and still applies to everything issued before the
store existed. The store is an overlay on top of it, not a replacement.

## The one thing in `next.config.ts` that makes this work

`outputFileTracingIncludes` names the attestation folders, and `loadAttestation`
scopes its reads to literal folders so the build can follow them. Without that,
Turbopack warns "Dynamic filesystem access causes tracing of the whole project"
and does what it says: every source file is deployed as part of the server code.
Both are kept — the second makes the files findable, the first guarantees they
are there regardless of how well static analysis does.

There is no `output` setting. An earlier one, `"standalone"`, broke the first
deploy: Vercel runs its own pipeline over the ordinary build output and opens
`.next/next-server.js.nft.json`, which standalone does not write, so the build
succeeded and then failed with `ENOENT`.

## Environment variables

Both deployments need these:

| Variable | Value |
| --- | --- |
| `QUIETSTAY_CONTRACT_ID` | `CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M` |
| `NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID` | the same |
| `QUIETSTAY_SEP10_SERVER_SECRET` | the SEP-10 challenge key — rotatable, safe here |
| `QUIETSTAY_SESSION_SECRET` | 32+ random characters |
| `QUIETSTAY_HOME_DOMAIN` | the deployment's host, e.g. `quietstay.app` |

The full deployment adds:

| Variable | Value |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | set by the Upstash integration |
| `UPSTASH_REDIS_REST_TOKEN` | set by the Upstash integration |
| `QUIETSTAY_ISSUER_SECRET` | the issuer's `S...` seed — **un-rotatable, read the warning above** |

Phase 3 adds, for passkey smart wallets on testnet:

| Variable | Value |
| --- | --- |
| `QUIETSTAY_TESTNET_FEE_SECRET` | `qs-fee-testnet`'s seed (you set it). The older name of `QUIETSTAY_FEE_SECRET`, still read on this testnet demo. Only `/api/tx/sponsor` reads it. Without a fee key, passkey wallets cannot be created or approve transactions; everything else works |
| `NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT` | optional; defaults to `qs-fee-testnet`'s public address `GCGDZWCL…L77Z` |
| `NEXT_PUBLIC_QUIETSTAY_WEB_AUTH_CONTRACT_ID` | optional; defaults to the testnet SEP-45 web-auth contract `CBCDSOZP…5KGM` |

The fee route's rate limits are kept in the Upstash store. Without a store
they are kept in a file, which does not survive on Vercel. So on Vercel the
route needs Upstash, and it refuses to sponsor anything when the store cannot
be reached. The SEP-45 sign-in also needs the SEP-10 signing account
(`QUIETSTAY_SEP10_SERVER_SECRET`'s public key) to exist on the network.

Never the `DEMO_*` keys — those are read only by the scripts, which do not run on
Vercel.

`QUIETSTAY_WEB_AUTH_DOMAIN` follows `QUIETSTAY_HOME_DOMAIN` when unset.

Paste values with no quotes and no trailing newline. A malformed seed is caught
and named rather than failing somewhere further in.

### The domain is a host, and it is read at runtime

`quietstay.app`. Not `https://quietstay.app`, not with a trailing
slash — SEP-10 puts `<home domain> auth` in the challenge the wallet displays,
and it wants a host there. A scheme or a path is stripped rather than carried
into a challenge no standard wallet would recognise, so a pasted address-bar URL
still works, but the value that is meant is the bare host.

It is deliberately **not** a `NEXT_PUBLIC_` variable. `sep10.ts` is the only
reader and never runs in a browser, so nothing is gained by shipping it there and
something is lost: `NEXT_PUBLIC_*` values are baked into the bundle at build time,
and the URL is not known until the first deploy has already happened. Read at
runtime, the domain can be corrected after the fact and takes effect on the next
request. The old `NEXT_PUBLIC_HOME_DOMAIN` still works for a deployment already
configured with it.

Getting it wrong does not break sign-in: the server builds and verifies the
challenge against the same constant, so it stays self-consistent. It breaks
something quieter — the app asks people to sign a message naming a site they are
not on, which is the one thing that field exists to prevent.

### If sign-in fails on the deployed app

Connecting the wallet succeeds and then the app says it could not build a
challenge: the two SEP-10 variables above are missing or malformed. They are
read when somebody signs in, not at build time, so the deploy is green and the
failure waits for the first visitor.

`/api/auth` answers **502** and names the variable — open it directly to see
which:

```
https://<your-app>.vercel.app/api/auth?account=G...
```

A 502 is the server admitting it cannot do its part. A 400 there means the
request was wrong instead; a challenge in the response means the keys are fine.
The message names variables, never values.

Both keys are safe to set here and both can be rotated — rotating the SEP-10 key
invalidates nothing but in-flight challenges, and rotating the session key signs
everyone out. Neither can move a week, and neither is the one that cannot be
replaced; that is `QUIETSTAY_ISSUER_SECRET`, discussed above.

## The store, and why the app needs one

Vercel has no disk. The app is served from its build output, mounted read-only,
so `writeFileSync` fails with `EROFS`. That is fine for the attestations that
shipped with the build and fatal for anything created once the app is running —
which is two things: an attestation for a week issued from the deployed app, and
a request to take a week off somebody.

Without a store the deployment is a read-only showcase. With one it is the whole
application.

### Setting it up

Vercel dashboard → **Storage** → **Redis** (Upstash) → create, then **Connect
Project**. The integration sets the variables itself; nothing needs copying by
hand. Redeploy afterwards — Vercel binds environment variables at deploy time, so
saving one does not reach the deployment already running.

Check which names it used, because it varies: **`UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN`** or **`KV_REST_API_URL` / `KV_REST_API_TOKEN`**.
Either pair is accepted. What is *not* used is `REDIS_URL` or `KV_URL` — those
are `rediss://` connection strings, and a serverless invocation cannot hold a TCP
connection open between requests, which is why this talks REST.

Doing it outside Vercel works identically: create a database at
[upstash.com](https://upstash.com), copy the two values from its **REST API**
panel, and add them to the project's environment variables by hand.

The free tier is far more than this uses: an attestation is about a kilobyte and
there is one per week.

### Why Redis and not blob storage

Blob storage would have done for attestations, which are written once and read
many times. Requests are read-modify-write — two people asking for the same week
seconds apart — and blob reads come through a CDN whose cache **cannot be set
below one minute**. That is a window in which the second writer reads a stale
list and erases the first, and nobody would ever see it happen.

### The store is an overlay, not a replacement

`loadAttestation` reads the store first and the files second, never one instead
of the other:

| Layer | Holds |
| --- | --- |
| the store | weeks issued since the build |
| `inventory/phase2/attestations/` | the weeks git carried, shipped with the build |

That is what lets a fresh deployment with an empty store keep showing every week
already attested, with no migration step. It also means an unreachable store
degrades rather than breaks: the registry falls back to what shipped.

### What it is not

Not a source of truth. The contract is. The store holds what the issuer has
vouched for and what people have asked for — both recoverable, neither able to
move a week. A store that vanished entirely would cost the registry its
verification badges and its pending asks, and cost nobody their property.

## What works, and what does not

| Route | No store | With a store |
| --- | --- | --- |
| `/api/auth` | works — SEP-10 | works |
| `/api/inventory` | works — chain, plus attestations from the build | plus what was issued since |
| `/api/attestation/[id]` | works | works |
| `/api/me`, `/api/right/[id]` | works — chain only | works |
| `/api/tx/build`, `/api/tx/submit` | works — no key, no writes | works |
| `/api/requests` GET | works | works |
| `/api/requests` POST | 503 — nowhere to keep an ask | **works** |
| `/api/issue` | 503 | **works** — with the issuer key |
| `/api/settle-fees` | 503 | **works** — with the issuer key |
| `/api/tx/proven-transfer` | works — no key | works |
| `/api/requests/consent` | works — no key, no writes | works |
| `/api/right/[id]/transfers` | works — chain events | works |

Two separate requirements, and the routes say which one they are missing. A
store with no issuer key still takes requests. An issuer key with no store is
the worse of the two, and is refused up front — see below.

### Issuing checks the store before it touches the chain

An issuance cannot be undone. Under Phase 1 a week issued without its attestation
could never be transferred, because the issuer's approval service would not
approve it; under Phase 2 nothing about a transfer depends on the attestation, but
a week with none leaves buyers nothing to read.

`/api/issue` used to submit first and write second. On a host with the issuer key
and no store that produced exactly that — right #36 exists on chain, has no
attestation, and is stuck. The check now runs first, and it actually pings the
store rather than trusting that credentials which are present are credentials
that work.

## The two apps: testnet and mainnet (decided 2026-11-28)

One repository, two Vercel projects, each with its own domain and its own
variables. The `NEXT_PUBLIC_` values are built into each app, so one build
can never switch networks; that is why there are two projects.

| | Testnet | Mainnet |
| --- | --- | --- |
| Host | `quietstay-rehearsal.vercel.app` | `quietstay.app` |
| Project | the existing demo project | a new project from the same repository, Production Branch `phase3` (later `main`) |
| `NEXT_PUBLIC_QUIETSTAY_NETWORK` | `testnet` | `mainnet` |
| `NEXT_PUBLIC_QUIETSTAY_SIGNING` | `server` (the demo: issuer key on the server, attestations) | `cli` (always on mainnet; a mainnet `server` build fails) |
| Rights contract | `CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM` | from Step 6 (`$QS_RIGHTS_CONTRACT`) |
| Web-auth, verifier | the demo's | from Step 6 (`$WEB_AUTH_ID`, `$VERIFIER_ID`) |
| `QUIETSTAY_HOME_DOMAIN` | `quietstay-rehearsal.vercel.app` | `quietstay.app` |
| Sign-in key (`QUIETSTAY_SEP10_SERVER_SECRET`) | the testnet sign-in key | `mainnet-test`'s secret, set by you |
| Fee account | `qs-fee-testnet` (`GCGD…L77Z`) | `qs-main-fee` (`$QS_MAIN_FEE`), its secret set by you |
| Store | the shared Upstash database, default prefix | the same database with `QUIETSTAY_KV_PREFIX=qs-mainnet`, or a database of its own |

**The host is not a detail on mainnet:**
- **Passkey wallets are bound to the host.** The smart-account kit uses the
  page's hostname as the WebAuthn relying party (`rpId`), so a passkey made
  on `quietstay.app` signs only on `quietstay.app`. If the host changed
  after the pilot began, those wallets' funds would stay on chain but their
  passkeys could no longer sign from the new host. So `quietstay.app` is
  fixed before the first passkey wallet is made.
- **Sign-in challenges name the home domain** (SEP-10, SEP-45) and the app
  serves `/.well-known/stellar.toml` on it. `QUIETSTAY_HOME_DOMAIN` must be
  exactly `quietstay.app`, with no scheme and no `www.`.
- Use one host only: if `www.quietstay.app` is added, make it redirect to
  `quietstay.app` (Vercel → Domains → Redirect), so nobody signs in or
  makes a passkey on the other.

**`quietstay.app` is taken today, by the earlier app.** Read on 2026-11-28,
it serves the Phase 1/2 testnet MVP ("Stellar testnet demo · no payments",
rights contract `CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD`)
from an existing Vercel project. Moving the domain to the mainnet app takes
that app off it:
- **Your decision (2026-11-28): last, once every test is done.** Until
  then `quietstay.app` keeps showing the earlier app, and the mainnet app
  runs on its project's own Vercel host (for example
  `quietstay-mainnet.vercel.app`), with `QUIETSTAY_HOME_DOMAIN` set to that
  host; at the move, it becomes `quietstay.app`.
- **Passkey wallets made before the move stay on the temporary host**: they
  cannot sign on `quietstay.app`. So the pilot's passkey wallets are test
  wallets: before the move, send their USDC back out (Wallet screen, or any
  transfer they sign on the temporary host), and make the real ones on
  `quietstay.app` after it. Freighter accounts are not affected.
- Anyone sent to `quietstay.app` for the testnet MVP lands on mainnet from
  then on; the testnet app is `quietstay-rehearsal.vercel.app`. Update any
  link you gave out (the SOW, reviewers, the survey) that means testnet.
- Either repurpose the existing project as the mainnet one (change every
  variable to the mainnet list and redeploy), or make a new project and move
  the domain to it (remove it from the old project's Domains, then add it to
  the new one). A new project is cleaner: no testnet setting can linger.

**Setting up `quietstay.app`:**
1. In the mainnet project: Settings → Domains → Add `quietstay.app` (after
   removing it from the earlier project, above).
2. At the domain's registrar, add the DNS records Vercel shows there, and
   wait for Vercel to mark the domain valid. Vercel issues the HTTPS
   certificate; `.app` domains work only over HTTPS, which Vercel provides.
3. Set the variables (the table above, then the `cli` list in the section
   below with mainnet values), and deploy.
4. Check it: [MAINNET_SETUP.md](MAINNET_SETUP.md) Part 6
   (`check-app-config --url https://quietstay.app --network mainnet …`).

**The testnet app stays the demo**, in `server` mode, for reviewers: issuing
on the server and attestations. The `cli` path that mainnet uses is tested
by the `cli-issue` browser spec and was dry-run on testnet on 2026-11-28
(PHASE3_PROGRESS.md). The separate `cli` rehearsal project described below
is optional now.

## The mainnet-like rehearsal project (Phase 3, Step 5)

*Optional since 2026-11-28: the testnet app is the demo at `quietstay-rehearsal.vercel.app` (above).*

A second Vercel project, on the free plan, from the same repository.
- It is testnet, configured exactly as mainnet will be: `cli` signing, so
  **no issuer key and no fee key on the server**, and no attestations.
- Issuing and the two passkey fee envelopes are built by the app and signed
  by you with `scripts/mainnet-sign-submit.sh`.
- It points at the rehearsal dry-run deployment, created 2026-11-22. Every
  entry is extended to about 2027-05-21
  (`evidence/checklist/rehearsal-app-ttl-2026-11-23.txt`):
  - rights `CC7W4OGPTTKUQNUFORFP5NXRTBV2L2VOX65X4Y5JV4ZXPRPVCPQ77ZRP`, the
    tested WASM, issuer `qs-issuer`, arbiter `qs-arbiter`, 1 USDC cap;
  - web-auth `CDJJSKRIS2CUKSPNO37Q56SY7QJBEOYOLTLLSKDUWGEF4EPR5BTIF5SN`;
  - WebAuthn verifier `CBZKYQIQ335HWKC55NFKOUKDIGDR6MHFWSLM6IITIXHQL2Z4GLXPSEHS`.

**The store: one Upstash database, shared, with its own prefix.**
- Upstash's free plan allows one database per account ("A free account can
  have 1 database", upstash.com/pricing/redis, read 2026-11-23).
- Connect the **existing** database to this project too (Vercel → Storage →
  the database → Connect Project).
- Set `QUIETSTAY_KV_PREFIX=qs-rehearsal`. The demo keeps the default prefix,
  `quietstay`, so its data is untouched.
- Every key also carries the contract id, so the two apps cannot read each
  other's requests, nonces or rate limits.
- Both apps count against the same free daily command quota.

### Steps

1. Push the branch, because Vercel builds from GitHub: `git push origin phase3`.
   - The demo project may also build a *preview* of `phase3`. That preview
     uses the demo's Preview variables, so it is not the rehearsal.
2. Vercel → Add New → Project. Import the same repository, and name it, for
   example, `quietstay-rehearsal`.
   - Framework: Next.js; the defaults are fine.
   - Settings → Git → **Production Branch: `phase3`**.
3. Set the variables below for **Production**, then deploy.
4. Once the first deploy gives you its host, set `QUIETSTAY_HOME_DOMAIN` to it.
   It is read at runtime, so a redeploy without rebuilding is enough.
5. Check it, and paste me the output:

   ```sh
   npx tsx scripts/check-app-config.ts --url https://<the rehearsal host> --network testnet --signing cli \
     --rights CC7W4OGPTTKUQNUFORFP5NXRTBV2L2VOX65X4Y5JV4ZXPRPVCPQ77ZRP \
     --web-auth CDJJSKRIS2CUKSPNO37Q56SY7QJBEOYOLTLLSKDUWGEF4EPR5BTIF5SN \
     --verifier CBZKYQIQ335HWKC55NFKOUKDIGDR6MHFWSLM6IITIXHQL2Z4GLXPSEHS \
     --fee-account GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z \
     --issuer GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE \
     --arbiter GACLONYVHKPB4BG3QUWMKG4LAKTRYKM4CFLBF4VTBAF5773X4UYZEEZC
   ```

   The script only reads the app's public `/api/network` and `stellar.toml`,
   and the chain. It sends nothing.

### Variables

| Variable | Value | Why |
| --- | --- | --- |
| `NEXT_PUBLIC_QUIETSTAY_NETWORK` | `testnet` | the network. On the mainnet project it will be `mainnet` |
| `NEXT_PUBLIC_QUIETSTAY_SIGNING` | `cli` | no issuer key on the server: issuing is a CLI envelope; no attestations. Mainnet is always `cli`. Passkey fees are paid by the limited fee key below (D18) |
| `NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID` | `CC7W4OGPTTKUQNUFORFP5NXRTBV2L2VOX65X4Y5JV4ZXPRPVCPQ77ZRP` | in `cli` mode there are no defaults: every id is set |
| `QUIETSTAY_CONTRACT_ID` | the same | the server-side name; kept equal |
| `NEXT_PUBLIC_QUIETSTAY_WEB_AUTH_CONTRACT_ID` | `CDJJSKRIS2CUKSPNO37Q56SY7QJBEOYOLTLLSKDUWGEF4EPR5BTIF5SN` | SEP-45 sign-in for passkey wallets |
| `NEXT_PUBLIC_QUIETSTAY_WEBAUTHN_VERIFIER_ID` | `CBZKYQIQ335HWKC55NFKOUKDIGDR6MHFWSLM6IITIXHQL2Z4GLXPSEHS` | our own verifier instance |
| `NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT` | `GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z` | the fee account's **public** key: passkey transactions name it as source. On mainnet: the mainnet fee account's. The fee route refuses to run if `QUIETSTAY_FEE_SECRET` is another account's key |
| `QUIETSTAY_FEE_SECRET` | that account's `S…`, **set by you, in Vercel only** | D18 (2026-11-27): the server pays passkey users' network fees, on mainnet too. The account holds only a few XLM (top it up on the Wallet screen, signed in as the issuer, or by sending XLM to its address); the route pays for QuietStay calls and passkey wallet creation only, at most 1 XLM each, within daily limits (mainnet: 10 per IP an hour, 10 per wallet and 50 in all a day; at most 5 XLM of fees a day, 0.5 XLM a transaction; 2 new passkey wallets per IP and 10 in all a day; 6 listing changes or offers per week a day). Never in a file |
| `QUIETSTAY_SEP10_SERVER_SECRET` | a testnet sign-in key's `S…` | signs the sign-in challenges. Use the demo's testnet sign-in key (`GDC2YUKY…`, already on testnet), or a new testnet key you fund with Friendbot. On mainnet this is `mainnet-test`'s secret, set only in Vercel |
| `QUIETSTAY_SESSION_SECRET` | 32+ random characters, e.g. `openssl rand -base64 48` | signs session cookies. Make a new one; don't copy the demo's |
| `QUIETSTAY_HOME_DOMAIN` | the rehearsal host, e.g. `quietstay-rehearsal.vercel.app` | the SEP-10/SEP-45 home domain. Set it after the first deploy (step 4) |
| `QUIETSTAY_KV_PREFIX` | `qs-rehearsal` | its own keys in the shared Upstash database |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | set by connecting the existing database | the store: requests, single-use nonces |

**Do not set** these on the rehearsal or the mainnet project:
- `QUIETSTAY_ISSUER_SECRET` and `QUIETSTAY_TESTNET_FEE_SECRET`. A `cli` build
  ignores them anyway, and `/api/network` shows `issuer_key_on_server: false`.
  The fee key goes under `QUIETSTAY_FEE_SECRET` only, and `/api/network`
  then shows `fee_route: true`;
- `NEXT_PUBLIC_QS_E2E_WALLET` (test builds only);
- `QUIETSTAY_DATA_DIR`.

The `NEXT_PUBLIC_` values are built into the app, so changing one needs a new
build. The others take effect on the next request.

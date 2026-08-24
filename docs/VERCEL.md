# Deploying to Vercel

There are two ways to run this, and the difference is whether the deployment can
act as the issuer. Both are supported; pick deliberately, because one of them
puts a key on a host that can never be taken back.

| | Showcase | Full |
| --- | --- | --- |
| Browse, verify, sign in, list/unlist | ✅ | ✅ |
| Ask for a week | needs a store | ✅ |
| Issue, settle fees, approve a transfer | ✗ | ✅ |
| `QUIETSTAY_ISSUER_SECRET` on the host | no | **yes** |
| Where weeks are issued | locally, then git | in the app |

## The one thing to understand before choosing

`QUIETSTAY_ISSUER_SECRET` signs every attestation and authorizes every transfer,
and unlike the other two secrets it **cannot be rotated** — the contract fixed
its issuer at construction. Replacing it means a new contract, a new address, and
every hash in [EVIDENCE.md](./EVIDENCE.md) pointing at a deployment nobody uses.
A key that leaks is leaked for the life of the deployment.

What it cannot do is worth stating just as plainly, because it is the project's
own claim being cashed: **even a host compromised completely could not take a
week.** `transfer` begins with `from.require_auth()`, and no server-side key
satisfies that — only the holder's wallet does. The worst a stolen issuer key can
do is **lie**: sign attestations for weeks that do not deserve them. Closing that
is what Phase 2 is for.

The other two secrets are rotatable and belong on the host either way. A forged
session convinces the app you are someone else, and then `transfer` asks for the
holder's wallet signature and gets nothing. Nothing moves.

## Showcase: attestations reach the host through git

The issuer's key stays where it already lives — a laptop, not a host — and the
server only ever **reads** what it signed:

```
1. issue a week locally          the key never leaves
2. inventory/attestations/       the signed file appears
3. git commit && git push
4. Vercel rebuilds               the registry shows it
```

Next's build traces `inventory/attestations` into the serverless functions, so
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
| `NEXT_PUBLIC_HOME_DOMAIN` | the deployment's host, e.g. `quietstay.vercel.app` |

The full deployment adds:

| Variable | Value |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | set by the Upstash integration |
| `UPSTASH_REDIS_REST_TOKEN` | set by the Upstash integration |
| `QUIETSTAY_ISSUER_SECRET` | the issuer's `S...` seed — **un-rotatable, read the warning above** |

Never the `DEMO_*` keys — those are read only by the scripts, which do not run on
Vercel.

`NEXT_PUBLIC_WEB_AUTH_DOMAIN` follows `NEXT_PUBLIC_HOME_DOMAIN` when unset.

Paste values with no quotes and no trailing newline. A malformed seed is caught
and named rather than failing somewhere further in.

### The domain is read at build time

`NEXT_PUBLIC_*` values are baked into the bundle, and the URL is not known until
the first deploy — which makes this awkward exactly once. Set the Vercel project
name first so the URL is predictable, then set the variable before deploying.

Getting it wrong does not break sign-in: the server builds and verifies the
challenge against the same constant, so it stays self-consistent. It breaks
something quieter — the app asks people to sign a message naming a site they are
not on, which is the one thing that field exists to prevent. No scheme, no
trailing slash.

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
everyone out. Neither can move a week. That is `QUIETSTAY_ISSUER_SECRET`, which
is not on this host.

## The store, and why the app needs one

Vercel has no disk. The app is served from its build output, mounted read-only,
so `writeFileSync` fails with `EROFS`. That is fine for the attestations that
shipped with the build and fatal for anything created once the app is running —
which is two things: an attestation for a week issued from the deployed app, and
a request to take a week off somebody.

Without a store the deployment is a read-only showcase. With one it is the whole
application.

### Setting it up

Vercel dashboard → **Storage** → **Marketplace** → **Upstash for Redis** →
create, and connect it to the project. The integration sets
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` itself; nothing needs
copying by hand. Redeploy afterwards.

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
| `inventory/attestations/` | the weeks git carried, shipped with the build |

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
| `/api/approve-transfer` | 503 | works — with the issuer key |
| `/api/tx/unapproved-transfer` | 503 | works — with the issuer key |

Two separate requirements, and the routes say which one they are missing. A
store with no issuer key still takes requests. An issuer key with no store is
the worse of the two, and is refused up front — see below.

### Issuing checks the store before it touches the chain

An issuance cannot be undone, and the attestation that goes with it is not
optional: `approve-transfer` will not approve a week the issuer has never
attested, so a right issued without one can never be transferred by anybody.

`/api/issue` used to submit first and write second. On a host with the issuer key
and no store that produced exactly that — right #36 exists on chain, has no
attestation, and is stuck. The check now runs first, and it actually pings the
store rather than trusting that credentials which are present are credentials
that work.

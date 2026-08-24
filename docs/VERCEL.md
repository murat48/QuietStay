# Deploying to Vercel

The public deployment runs **without the issuer key**, and that is the design
rather than a limitation being worked around.

Three secrets exist and only one of them matters here. `QUIETSTAY_ISSUER_SECRET`
signs every attestation and authorizes every transfer, and unlike the other two
it **cannot be rotated** — the contract fixed its issuer at construction, so
replacing it means a new contract, a new address, and every hash in
[EVIDENCE.md](./EVIDENCE.md) pointing at a deployment nobody uses. It does not go
on a host somebody else operates.

The other two can. A forged session convinces the app you are someone else, and
then `transfer` asks for the holder's wallet signature and gets nothing. Nothing
moves. Worth stating plainly, because it is the project's own claim being cashed:
even a host compromised completely could not **take** a week — `transfer` begins
with `from.require_auth()`. The worst a stolen issuer key can do is **lie**, and
closing that is what Phase 2 is for.

## Attestations are not created on the server

This is the part worth getting straight before anything else. An attestation is
signed by the issuer, and the issuer's key lives wherever it already lives — a
laptop, not a host. The server only ever **reads** them.

So the loop is:

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

Set these in the Vercel project. Three of them, plus the domain.

| Variable | Value |
| --- | --- |
| `QUIETSTAY_CONTRACT_ID` | `CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M` |
| `NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID` | the same |
| `QUIETSTAY_SEP10_SERVER_SECRET` | the SEP-10 challenge key — rotatable, safe here |
| `QUIETSTAY_SESSION_SECRET` | 32+ random characters |
| `NEXT_PUBLIC_HOME_DOMAIN` | the deployment's host, e.g. `quietstay.vercel.app` |

**Not** `QUIETSTAY_ISSUER_SECRET`. Not the `DEMO_*` keys either — those are read
only by the scripts, which do not run on Vercel.

`NEXT_PUBLIC_WEB_AUTH_DOMAIN` follows `NEXT_PUBLIC_HOME_DOMAIN` when unset.

### The domain is read at build time

`NEXT_PUBLIC_*` values are baked into the bundle, and the URL is not known until
the first deploy — which makes this awkward exactly once. Set the Vercel project
name first so the URL is predictable, then set the variable before deploying.

Getting it wrong does not break sign-in: the server builds and verifies the
challenge against the same constant, so it stays self-consistent. It breaks
something quieter — the app asks people to sign a message naming a site they are
not on, which is the one thing that field exists to prevent. No scheme, no
trailing slash.

## What works, and what does not

Vercel serves the app from a read-only filesystem. That is a limitation for one
route and a guarantee everywhere else: nothing an attacker did could persist.

| Route | On Vercel |
| --- | --- |
| `/api/auth` | works — SEP-10, both keys rotatable |
| `/api/inventory` | works — chain, plus the attestations from the build |
| `/api/attestation/[id]` | works |
| `/api/me`, `/api/right/[id]` | works — chain only |
| `/api/tx/build`, `/api/tx/submit` | works — no key, no writes |
| `/api/issue` | 503 — needs the issuer key |
| `/api/settle-fees` | 503 — needs the issuer key |
| `/api/approve-transfer` | 503 — needs the issuer key |
| `/api/tx/unapproved-transfer` | 503 — needs the issuer key |
| `/api/requests` POST | 503 — nothing writable to keep an ask in |
| `/api/requests` GET | works |

In screen terms: browsing the registry, verifying a week, signing in, seeing
your roles, and **publishing or withdrawing an offer** all work. `list` and
`unlist` ask the contract for the holder's signature and nobody else's, so they
need no key and no server-side storage.

Issuing, recording a fee settlement, and completing a transfer do not — by
design, not by accident.

### Why requests are refused rather than kept in `/tmp`

`/tmp` is writable on Vercel, and using it would be the obvious dodge. Every
invocation may land on a different instance, so the request would be accepted,
acknowledged, and gone before the holder ever saw it. Losing somebody's ask
silently is worse than declining to take it, so the interface hides the control
and the route answers 503 with a reason.

Making them work needs a store that outlives an invocation — Vercel KV or
Postgres behind `src/lib/requests.ts`, which is two functions wide. That is a
deliberate decision to take, not a gap to fall into.

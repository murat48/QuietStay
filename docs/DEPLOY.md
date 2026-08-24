# Self-hosting in a container

**The deployment is [VERCEL.md](./VERCEL.md).** This page is for running the same
thing on your own machine or host instead — the security reasoning below is
identical, and a container gets you one thing Vercel cannot: a writable store, so
the request flow works.

A public deployment of this app is expected to run **without the issuer key**.
That is the design of it, not a limitation being worked around.

## Why the key stays home

Three secrets exist. Only one of them matters here.

| Secret | Rotatable | If it leaked |
| --- | --- | --- |
| `QUIETSTAY_ISSUER_SECRET` | **No** | signs attestations, authorizes transfers |
| `QUIETSTAY_SEP10_SERVER_SECRET` | yes | forges auth challenges |
| `QUIETSTAY_SESSION_SECRET` | yes | forges sessions |

The issuer key cannot be rotated because the contract fixed its issuer at
construction — `__constructor(env, issuer, …)`. A replacement means a new
contract, a new address, and every hash in [EVIDENCE.md](./EVIDENCE.md) pointing
at a deployment nobody uses. So it does not go on a host somebody else operates.

The other two can go anywhere, because the contract contains what they buy: a
forged session convinces the app you are someone else, and then `transfer` asks
for the holder's wallet signature and gets nothing. Nothing moves.

Worth stating plainly, because it is the project's own claim being cashed: even a
host compromised completely, issuer key and all, cannot **take** a week.
`transfer` begins with `from.require_auth()`. The worst a stolen issuer key can
do is **lie** — attest that a week is clean when it is not. That is the trust
boundary Phase 1 declares and Phase 2 exists to close.

## What runs without it

| Works | Needs the key |
| --- | --- |
| The registry, with fees and property | Issuing a right |
| Verification, entirely client-side | Recording a fee settlement |
| Asking for a week, declining, withdrawing | Approving a transfer |

The request flow works because none of it touches the issuer: `/api/requests`
and `/api/requests/[id]` need a SEP-10 session and somewhere to write, and
nothing else. Only the final approval needs a signature.

Routes that need the key answer **503** with `read_only: true` and say why. The
interface reads the same flag from `/api/me` and stops offering those controls,
so nobody spends a signature discovering it.

## Building and running it

```bash
docker build -t quietstay \
  --build-arg NEXT_PUBLIC_HOME_DOMAIN=quietstay.example.com \
  --build-arg NEXT_PUBLIC_WEB_AUTH_DOMAIN=quietstay.example.com \
  --build-arg NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M \
  .

docker run -p 3000:3000 -v quietstay-data:/data \
  -e QUIETSTAY_CONTRACT_ID=CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M \
  -e QUIETSTAY_SEP10_SERVER_SECRET=S... \
  -e QUIETSTAY_SESSION_SECRET=... \
  quietstay
```

No `QUIETSTAY_ISSUER_SECRET`. That is the point.

### The domain has to be right at build time

`NEXT_PUBLIC_*` values are read when the bundle is built, so they are build
arguments rather than runtime environment.

Getting the domain wrong does **not** break sign-in — the server builds and
verifies the challenge against the same constant, so it stays self-consistent.
It breaks something quieter: the app asks people to sign a message naming a site
they are not on, which is the one thing that field exists to prevent. Set it to
the host you will actually serve from, with no scheme and no trailing slash.

### The volume is mounted at `/data`, not at `inventory/`

Mounting over `inventory/` would hide the attestations copied into the image
behind an empty directory, and every week would read as never attested. The
store searches the writable root first and the image second, so a fresh volume
adds to what shipped rather than replacing it.

## What is not in the image

The build context is an **allowlist** — see [`.dockerignore`](../.dockerignore).
Everything is excluded and the build's real inputs are named back in.

This is not caution for its own sake. Next's file tracer cannot resolve
`resolve(process.cwd(), dir, …)` statically, so it copies broadly: a build from
an unrestricted context put `2.pdf` — the statement of work — and the private
ownership records into `.next/standalone`, from where a naive `COPY` would have
carried them into a published image. The context now excludes them, and the
Dockerfile copies named parts of the standalone output rather than all of it.
Two locks, because the first one was observed to fail.

Never in the image: the statement of work, `.env*`, `inventory/records`,
`inventory/canonical`, `inventory/requests`, or `.git`.

In the image: `inventory/attestations` — the issuer's *public* statements. A
town, a bedroom count, a commitment and a signature. The documents those
commitments are over are not there.

## What was verified

An image was built and run. Results, on Docker 29.1.3:

| | |
| --- | --- |
| Image size | **292 MB** |
| `2.pdf`, records, canonical forms, requests, `.env*` — anywhere on the filesystem | absent |
| Secrets in the environment | none |
| Process user | `uid=1001(quietstay)` — not root |
| `/app` writable | no |
| `/data` writable by that user | yes |
| `inventory/` in the image | `attestations` only, 24 files |
| `@trezor`, `usb`, `@coinbase` in the shipped `node_modules` | absent |
| Docker's own `HEALTHCHECK` | healthy |

Then, running with an **empty** `/data` volume and no `QUIETSTAY_ISSUER_SECRET`:

| | |
| --- | --- |
| All five pages | 200 |
| Registry | 27 rights, 24 attested with property |
| `/api/attestation/1` | 200 |
| SEP-10 challenge | built and signed, 388 bytes |
| `issue`, `settle-fees`, `approve-transfer`, `unapproved-transfer` | 503, `read_only: true` |

The empty volume is the point of that second table: the attestations still read,
which is what mounting at `/data` rather than over `inventory/` buys.

Two things the build taught, both kept above: `npm ci` needs
`--ignore-scripts`, and the tree-shaking claim in the README is now checked at
the image rather than asserted — `@trezor` and its native `usb` dependency are
installed during the build and do not survive into the runtime stage.

## Checking the image you built

There is no published tag. There was one, and it went four commits stale inside a
day — a snapshot nobody maintains is worse than none, so it was taken down and
the Dockerfile kept. Build from source and check what you built:

```bash
docker run --rm quietstay find / -name '2.pdf' -o -name 'week-0*.json' 2>/dev/null
docker run --rm quietstay env | grep -i secret
docker run --rm quietstay id            # uid=1001(quietstay) — never root
```

The first two should print nothing.

## Where the privileged flows happen

On a machine holding the key — the same `.env.local` that runs `npm run dev`
today. Issue a right, settle a fee, approve a transfer there; the public
deployment shows the result the moment it reads the contract again, because the
registry comes from the chain rather than from a local cache.

The one thing it will not see is a new attestation, which lives in the issuing
machine's `inventory/attestations`. Copy it to the volume, or rebuild.

## Attestations the registry will not show

`/api/inventory` verifies an attestation's **provenance** before displaying it —
that the issuer signed it, for this right, on this contract and network, and
that the signature still covers the bytes. It does not require the news to be
good: sample week 04 says the fees are unpaid and the registry says so too.
Suppressing that behind "not attested" would replace a true statement with a
false one.

The reason is the workflow above rather than an attacker. Attestations reach a
deployment by being copied into a volume by hand as new weeks are issued, and a
file saved under the wrong name — `right-28` as `right-27` — would otherwise be
shown as that week's town and fee state with nothing anywhere saying it was
wrong. It now reads as never attested, which is visible and prompts a fix.

Fail-closed, and worth knowing: a bad file in the volume shadows the good copy in
the image rather than falling through to it. Someone with write access to `/data`
can make a week *look* unattested; they cannot make one look attested that is not.
A transfer was never at risk either way — `/api/approve-transfer` has always run
the full verification, including the commitment against the ledger.

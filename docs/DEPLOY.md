# Deploying

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

## Running it

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

## What was verified, and what was not

Docker is not installed on the machine this was written on, and installing it
needs root, so **no image has been built**. What was verified is the thing that
would make an image wrong.

A build context holding exactly the files the Dockerfile copies — and nothing
else — was assembled, built, and run:

| | |
| --- | --- |
| `next build` from those inputs alone | succeeds |
| `.next/standalone` | **43 MB**, against 2.3 GB from the repository root |
| the statement of work, records, canonical forms, requests, `.env*` | absent |
| `inventory/` in the output | `attestations` only |

The run stage's `COPY` list was then reproduced file by file and started with no
`QUIETSTAY_ISSUER_SECRET` and an empty `/data`:

| | |
| --- | --- |
| all five pages | 200 |
| the registry, with fees and property | reads |
| `issue`, `settle-fees`, `approve-transfer`, `unapproved-transfer` | 503, `read_only: true` |
| the healthcheck's `wget` | passes |

That covers the filesystem and the behaviour. It does not cover Alpine, `npm ci`
in the image, the non-root user, or the `HEALTHCHECK` as Docker runs it. Build
one and run the three checks below.

## Checking a built image

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

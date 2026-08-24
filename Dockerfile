# QuietStay — Phase 1, read-only public deployment.
#
# This image is built to run **without the issuer key**. That is the whole point
# of it, not a limitation to work around: `QUIETSTAY_ISSUER_SECRET` signs every
# attestation and authorizes every transfer, and the contract fixed its issuer at
# construction — so unlike the other two secrets it can never be rotated. A key
# that reached a public host could not be taken back. Issuing, attesting and
# approving are done from wherever the key already lives; this serves the
# registry, verification, and the request flow, none of which need it.
#
# Set QUIETSTAY_ISSUER_SECRET anyway and everything works — the app checks for it
# rather than being compiled one way or the other. Do that only somewhere you
# control.
#
#   docker build -t quietstay .
#   docker run -p 3000:3000 --env-file .env.docker -v quietstay-data:/data quietstay

# --- build ------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
#
# `--ignore-scripts` is not a workaround, though it started as one. `npm ci`
# fails here without it: `@creit.tech/stellar-wallets-kit` depends on
# `@trezor/connect`, which depends on `usb`, which is a native module that wants
# Python and a C++ toolchain to build. This app never touches a hardware wallet —
# the kit is loaded with six named modules and Trezor is not among them — so the
# alternative was installing a compiler to build a USB driver that would then sit
# in the image, unused and compiled from source.
#
# Refusing to run install scripts is also the stronger position on its own terms:
# no dependency executes arbitrary code while the image is being built. Nothing
# in this project has an install script of its own, so nothing is lost.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Named inputs, never `COPY . .`.
#
# `.dockerignore` excludes everything and names these back in, so a `COPY . .`
# would be equivalent *if the exclusion rules are right*. This does not depend on
# their being right. Nothing can reach the image that is not listed here, whatever
# a pattern does or does not match — and the file that would have leaked, the
# statement of work, is exactly the kind that arrives later and matches no rule
# anyone wrote in advance.
COPY next.config.ts tsconfig.json ./
COPY src ./src
COPY inventory/attestations ./inventory/attestations
COPY inventory/evidence/attestations ./inventory/evidence/attestations

# NEXT_PUBLIC_* values are read at build time, so the domain SEP-10 will name has
# to be known here. Getting it wrong does not break the handshake — the server
# builds and verifies the challenge against the same constant — but it makes the
# app ask people to sign a message naming a site they are not on, which is the
# one thing that field exists to prevent.
ARG NEXT_PUBLIC_HOME_DOMAIN
ARG NEXT_PUBLIC_WEB_AUTH_DOMAIN
ARG NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID
ENV NEXT_PUBLIC_HOME_DOMAIN=$NEXT_PUBLIC_HOME_DOMAIN \
    NEXT_PUBLIC_WEB_AUTH_DOMAIN=$NEXT_PUBLIC_WEB_AUTH_DOMAIN \
    NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=$NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID

RUN npm run build

# --- run --------------------------------------------------------------------
FROM node:24-alpine AS run
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    QUIETSTAY_DATA_DIR=/data

# Never root. Next's standalone server needs nothing privileged.
RUN addgroup -g 1001 -S quietstay && adduser -u 1001 -S quietstay -G quietstay

# Named parts of the standalone output, not the whole of it.
#
# Next's tracer resolves `resolve(process.cwd(), dir, …)` by copying broadly: a
# build from an unrestricted context put the statement of work and the private
# ownership records into `.next/standalone`. `.dockerignore` keeps them out of
# the context so they cannot be traced at all — this is the second lock, because
# one boundary that has already been observed to leak is not a boundary.
COPY --from=build --chown=quietstay:quietstay /app/.next/standalone/server.js ./server.js
COPY --from=build --chown=quietstay:quietstay /app/.next/standalone/package.json ./package.json
COPY --from=build --chown=quietstay:quietstay /app/.next/standalone/node_modules ./node_modules
COPY --from=build --chown=quietstay:quietstay /app/.next/standalone/.next ./.next
COPY --from=build --chown=quietstay:quietstay /app/.next/static ./.next/static

# The attestations that shipped with the build. Copied explicitly rather than
# left to Next's file tracing: tracing does find them today, but it infers them
# from a string pattern, and an evidence document that silently loses its
# attestations is not a thing to leave to inference.
#
# These are the issuer's *public* statements — a town, a bedroom count, a
# commitment and a signature. The ownership records they commit to are not here
# and never enter the image.
COPY --from=build --chown=quietstay:quietstay /app/inventory/attestations ./inventory/attestations
# Rights 5-7 live here — see .dockerignore. The records under
# inventory/evidence/canonical are not copied and are not in the context.
COPY --from=build --chown=quietstay:quietstay /app/inventory/evidence/attestations ./inventory/evidence/attestations

# The writable volume. Kept apart from ./inventory on purpose: mounting over that
# directory would hide the attestations copied above behind an empty mount, and
# every week would read as never attested.
RUN mkdir -p /data && chown -R quietstay:quietstay /data
VOLUME ["/data"]

USER quietstay
EXPOSE 3000

# `wget` is in busybox, so this adds nothing to the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/inventory > /dev/null || exit 1

CMD ["node", "server.js"]

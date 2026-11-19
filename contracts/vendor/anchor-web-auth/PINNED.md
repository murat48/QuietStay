# SEP-45 web-auth contract — vendored, unmodified

Copied byte for byte from the Anchor Platform repository. Nothing here is
edited. QuietStay uses it only to sign in smart wallets (`C…` accounts) with
SEP-45. It holds no rights and no money, and the rights contract never calls it.

| | |
| --- | --- |
| Source | https://github.com/stellar/java-stellar-anchor-sdk, `soroban/` |
| Pinned commit | `dc5817fb41b347fd70d36cd1430bd769d59ed3c3` (2026-10-22, the latest commit touching `soroban/`) |
| Files | `Cargo.toml`, `Cargo.lock` (workspace), `contracts/web-auth/{Cargo.toml,README.md,src/lib.rs}`, `LICENSE` (Apache-2.0) |
| soroban-sdk | 26.0.0, as pinned by its `Cargo.lock` |
| Spec | SEP-45 v0.1.1 (stellar-protocol `355ed759`), "Web Authentication Contract" |

## Its `upgrade` function and admin

The contract has `upgrade(new_wasm_hash)`, gated by an `admin` address set in
the constructor. QuietStay's rule is no upgrade function and no admin key. So
QuietStay deploys it with an admin that nobody can authorize:

    admin = the contract address whose 32-byte id is
            SHA-256("QuietStay SEP-45 web-auth: no admin")

No contract exists at that id, and none can be created there. A contract id
is the SHA-256 of a deployment preimage, so putting a contract at a chosen id
would need a SHA-256 preimage. `require_auth` on that address therefore always
fails, and `upgrade` can never run. `scripts/deploy-web-auth.ts` computes the
address and checks the constructor argument before deploying.

## Build

    cd contracts/vendor/anchor-web-auth && stellar contract build

The WASM hash is recorded in docs/PHASE3_PROGRESS.md, Addresses.

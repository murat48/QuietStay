/**
 * Read-only check after each part of docs/MAINNET_SETUP.md. You run it in
 * your own terminal and paste its output back.
 *
 *   npx tsx scripts/check-mainnet-setup.ts --part 1|2|3|4 [--quote]
 *   npx tsx scripts/check-mainnet-setup.ts --network testnet --part 1|2|3|4   (the rehearsal)
 *
 * It reads only public data from mainnet Horizon (https://horizon.stellar.org)
 * and the public keys you exported in the runbook (QS_MAIN_ISSUER,
 * QS_MAIN_ARBITER, QS_MAIN_FEE, QS_MAIN_OWNER, QS_MAIN_BUYER, QS_MAIN_RENTER).
 * With `--network testnet` (docs/MAINNET_REHEARSAL.md) it reads testnet
 * Horizon, Circle's testnet USDC issuer and the QS_REHEARSAL_* keys, and the
 * sign-in key is QS_REHEARSAL_SIGNIN instead of `mainnet-test`. The checks are
 * the same, except that the deployer's Part 2 minimum does not wait for the
 * sign-in key's surplus (Friendbot gives it 10,000 XLM), and there is no DEX
 * quote.
 * It uses no key, signs nothing and sends nothing.
 *
 * - Part 1 (identities): six valid, distinct public keys, none of them a
 *   testnet identity or the sign-in key, and none already on mainnet.
 * - Part 2 (funding): each account exists with at least its planned XLM, has
 *   only its own master key as signer, and holds nothing else.
 * - Part 3 (mainnet-test): the sign-in key holds exactly the minimum balance
 *   (1 XLM, 0 subentries), and its last payment went to the deployer.
 * - Part 4 (USDC): owner, buyer and renter have a USDC trustline to Circle's
 *   issuer (any limit since decision 3, 2026-11-23: added in Freighter, and
 *   the limit is printed); issuer, arbiter, fee and sign-in key have
 *   none (so they can hold no USDC); the total is at most 5 USDC.
 *   `--quote` prints the live DEX cost of the planned USDC and the exact
 *   path-payment commands, with a send-max 3% above the quote.
 *
 * Exit code 0 only if every check of the part passes.
 */

import { parseArgs } from "node:util";

import { StrKey } from "@stellar/stellar-sdk";

const NETWORK = (() => {
  const i = process.argv.indexOf("--network");
  return i >= 0 ? process.argv[i + 1] : "mainnet";
})();
if (NETWORK !== "mainnet" && NETWORK !== "testnet") throw new Error("--network mainnet|testnet");
const TESTNET = NETWORK === "testnet";
const HORIZON = TESTNET ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org";
const PASSPHRASE = TESTNET ? "Test SDF Network ; September 2015" : "Public Global Stellar Network ; September 2015";
const USDC_ISSUER = TESTNET ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" : "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const PREFIX = TESTNET ? "QS_REHEARSAL" : "QS_MAIN";
const SIGN_IN = TESTNET ? (process.env.QS_REHEARSAL_SIGNIN ?? "").trim() : "GCEF3BTQVDJ473URMW4556VG67YAPS2J5OP77FBXT7T47M2DOIZ7TDAR";
const SIGN_IN_NAME = TESTNET ? "the rehearsal sign-in key" : "mainnet-test";
const STROOPS = 10_000_000n;

/** Testnet identities from docs/PHASE3_PROGRESS.md (Addresses); mainnet keys must be new. */
const TESTNET_KEYS: Record<string, string> = {
  GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE: "qs-issuer (testnet)",
  GACLONYVHKPB4BG3QUWMKG4LAKTRYKM4CFLBF4VTBAF5773X4UYZEEZC: "qs-arbiter (testnet)",
  GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z: "qs-fee-testnet",
  GBCETLZR2XY5S3DBCWUJRNS7ITYYMOJGTQVLNNQ77P2TLRKDUHLR4AYR: "qs-owner (testnet)",
  GB3VDHPHD27MVDMQAN5JD3EUGWTX76W7SJWHKG4EPITK2WOOAPX5UWVQ: "qs-buyer (testnet)",
  GBNDVZTDK7IOUFEAZH4ZBJ25WT2FXJ4IZPXWADAD4BEQPDD5FDQNZAXN: "qs-renter (testnet)",
  GDC2YUKYIPDETC6M7QVOL4222SJF6MVYCW5ZOOVFQEZQQPYIENPLRRGQ: "testnet sign-in key",
};

/**
 * The planned XLM per account (docs/MAINNET_SETUP.md, the budget), in stroops.
 * Part 2 is checked before mainnet-test's surplus reaches the deployer
 * (Part 3), so the deployer's Part 2 minimum is lower by that surplus.
 */
const ROLES = ["issuer", "arbiter", "fee", "owner", "buyer", "renter"] as const;
type Role = (typeof ROLES)[number];
const SURPLUS = 80_000_900n; // 9.0001000 − 1 − 0.0000100 XLM, from mainnet-test (Part 3)
const PLAN_DEX: Record<Role, bigint> = {
  issuer: 750_000_000n,
  arbiter: 20_000_000n,
  // D18 (2026-11-27): the fee account pays every passkey transaction, within a 5 XLM daily budget.
  fee: 50_000_000n,
  owner: 30_000_000n,
  // 22 XLM since 2026-11-28: 2 USDC rose to ~16.2 XLM on the DEX.
  buyer: 220_000_000n,
  renter: 220_000_000n,
};
const PLAN_EXCHANGE_USDC: Record<Role, bigint> = { ...PLAN_DEX, buyer: 30_000_000n, renter: 30_000_000n };
/** The planned USDC, in 7-decimal units: 2 + 2 = 4, under the 5 USDC cap (D7). */
const USDC_PLAN: Partial<Record<Role, bigint>> = { buyer: 20_000_000n, renter: 20_000_000n };
const USDC_CAP = 50_000_000n;
const TRUSTLINE_LIMIT = 50_000_000n;

interface Balance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
}
interface Account {
  account_id: string;
  balances: Balance[];
  subentry_count: number;
  signers: { key: string; weight: number; type: string }[];
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  flags: Record<string, boolean>;
  home_domain?: string;
  num_sponsoring: number;
  num_sponsored: number;
  data: Record<string, string>;
}

let failures = 0;
function check(ok: boolean, line: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${line}`);
  if (!ok) failures++;
}

/** "12.3456789" → 123456789n, exactly (no floating point). */
function units(s: string): bigint {
  const [i = "0", f = ""] = s.split(".");
  return BigInt(i) * STROOPS + BigInt((f + "0000000").slice(0, 7));
}
function fmt(x: bigint): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  return `${neg ? "-" : ""}${a / STROOPS}.${(a % STROOPS).toString().padStart(7, "0")}`;
}

async function get<T>(path: string): Promise<{ status: number; body: T | null }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${HORIZON}${path}`);
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      return { status: res.status, body: (await res.json()) as T };
    } catch (e) {
      // A dropped connection (this machine's line) is retried; a read only.
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

const account = (g: string) => get<Account>(`/accounts/${g}`);

function xlm(a: Account): bigint {
  return units(a.balances.find((b) => b.asset_type === "native")!.balance);
}
function usdcLine(a: Account): Balance | undefined {
  return a.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
}
/** (2 + subentries) × 0.5 XLM, the base reserve read from the latest ledger. */
async function baseReserve(): Promise<bigint> {
  const l = await get<{ _embedded: { records: { base_reserve_in_stroops: number }[] } }>("/ledgers?order=desc&limit=1");
  return BigInt(l.body!._embedded.records[0]!.base_reserve_in_stroops);
}

function plainAccount(role: string, a: Account) {
  const only = a.signers.length === 1 && a.signers[0]?.key === a.account_id && a.signers[0]?.weight === 1;
  check(only, `${role}: the only signer is its own master key, weight 1`);
  const t = a.thresholds;
  check(t.low_threshold === 0 && t.med_threshold === 0 && t.high_threshold === 0, `${role}: thresholds 0/0/0 (unchanged)`);
  check(!Object.values(a.flags).some(Boolean) && !a.home_domain && Object.keys(a.data).length === 0, `${role}: no flags, home domain or data entries`);
  check(a.num_sponsoring === 0 && a.num_sponsored === 0, `${role}: sponsors nothing and is sponsored by nothing`);
}

function keys(): Record<Role, string> {
  const out = {} as Record<Role, string>;
  for (const r of ROLES) {
    const name = `${PREFIX}_${r.toUpperCase()}`;
    const v = (process.env[name] ?? "").trim();
    out[r] = v;
    check(StrKey.isValidEd25519PublicKey(v), `${name} is a public key (G…): ${v || "(not set)"}`);
  }
  return out;
}

async function main() {
  const { values: a } = parseArgs({
    options: { part: { type: "string" }, quote: { type: "boolean", default: false }, usdc: { type: "string", default: "dex" }, network: { type: "string", default: "mainnet" } },
  });
  const part = Number(a.part);
  if (![1, 2, 3, 4].includes(part)) throw new Error("--part 1|2|3|4");
  const route = a.usdc === "exchange" ? "exchange" : "dex";
  const plan = route === "dex" ? PLAN_DEX : PLAN_EXCHANGE_USDC;

  const root = await get<{ network_passphrase: string }>("/");
  if (root.body?.network_passphrase !== PASSPHRASE) throw new Error(`Horizon is not ${NETWORK}`);
  if (TESTNET) check(StrKey.isValidEd25519PublicKey(SIGN_IN), `QS_REHEARSAL_SIGNIN is a public key (G…): ${SIGN_IN || "(not set)"}`);
  console.log(`check-mainnet-setup part ${part}, ${NETWORK} Horizon, read-only, ${new Date().toISOString()}`);
  console.log(`USDC route: ${route} (--usdc dex|exchange)`);
  const k = keys();
  if (failures) process.exit(1);
  const reserve = await baseReserve();

  if (part === 1) {
    const all = [...ROLES.map((r) => k[r]), SIGN_IN];
    check(new Set(all).size === all.length, "the six keys and the sign-in key are all different");
    check(k.issuer !== k.arbiter, "the arbiter is not the issuer (the constructor refuses that too)");
    for (const r of ROLES) {
      check(!TESTNET_KEYS[k[r]], `${r}: not a testnet identity${TESTNET_KEYS[k[r]] ? ` (it is ${TESTNET_KEYS[k[r]]})` : ""}`);
      const acc = await account(k[r]);
      check(acc.status === 404, `${r}: not on ${NETWORK} yet (a new key)${acc.status !== 404 ? " — it already exists: is this key new?" : ""}`);
    }
  }

  if (part === 2 || part === 3 || part === 4) {
    for (const r of ROLES) {
      const acc = await account(k[r]);
      if (!acc.body) {
        check(false, `${r}: exists on mainnet`);
        continue;
      }
      const bal = xlm(acc.body);
      // 0.01 XLM allowance for the runbook's own transaction fees (100 stroops each).
      let want = plan[r] - 100_000n;
      if (r === "issuer" && part === 2 && !TESTNET) want -= SURPLUS;
      // After Part 4 the buyer and renter have spent XLM on USDC.
      if (part === 4 && (r === "buyer" || r === "renter")) want = PLAN_EXCHANGE_USDC[r] - 5_000_000n;
      const min = (2n + BigInt(acc.body.subentry_count)) * reserve;
      check(bal >= want, `${r}: ${fmt(bal)} XLM ≥ planned ${fmt(want)} (minimum balance ${fmt(min)}, ${acc.body.subentry_count} subentries)`);
      plainAccount(r, acc.body);
      if (part === 2 || part === 3) {
        check(acc.body.balances.length === 1, `${r}: holds XLM only`);
      }
    }
  }

  if (part === 3) {
    const acc = await account(SIGN_IN);
    if (!acc.body) {
      check(false, `${SIGN_IN_NAME} exists`);
    } else {
      const bal = xlm(acc.body);
      const min = (2n + BigInt(acc.body.subentry_count)) * reserve;
      check(acc.body.subentry_count === 0, `${SIGN_IN_NAME}: 0 subentries (${acc.body.subentry_count})`);
      check(bal === min, `${SIGN_IN_NAME}: ${fmt(bal)} XLM = the minimum balance ${fmt(min)}`);
      plainAccount(SIGN_IN_NAME, acc.body);
      const pays = await get<{ _embedded: { records: { type: string; from?: string; to?: string; account?: string; amount?: string; starting_balance?: string; transaction_hash: string; created_at: string }[] } }>(
        `/accounts/${SIGN_IN}/payments?order=desc&limit=1`,
      );
      const p = pays.body?._embedded.records[0];
      const to = p?.to ?? p?.account;
      check(!!p && p.from === SIGN_IN && to === k.issuer, `${SIGN_IN_NAME}'s last payment went to the deployer: ${p ? `${p.type} ${p.amount ?? p.starting_balance} XLM, tx ${p.transaction_hash}, ${p.created_at}` : "none"}`);
    }
  }

  if (part === 4) {
    let total = 0n;
    for (const r of ROLES) {
      const acc = (await account(k[r])).body;
      if (!acc) continue;
      const line = usdcLine(acc);
      const receives = r === "owner" || r === "buyer" || r === "renter";
      if (receives) {
        check(!!line, `${r}: has a USDC trustline to Circle's issuer`);
        if (line) {
          // Decision 3 (2026-11-23): trustlines come from Freighter's own
          // screens, with no 5 USDC limit; the total below is the hard rule.
          console.log(`  · ${r}: trustline limit ${line.limit}${units(line.limit!) === TRUSTLINE_LIMIT ? " (5 USDC)" : " (no 5 USDC limit; the total is checked)"}`);
          const held = units(line.balance);
          total += held;
          const want = USDC_PLAN[r] ?? 0n;
          // A DEX swap in Freighter can deliver a little more than asked
          // (2.0331300 on 2026-11-28); at least the plan is enough, and the
          // 5 USDC total below stays the hard rule (D7).
          check(want === 0n ? held === 0n : held >= want, `${r}: holds ${fmt(held)} USDC (planned ${want === 0n ? "0" : `at least ${fmt(want)}`})`);
        }
      } else {
        check(!line, `${r}: no USDC trustline, so it can hold no USDC`);
      }
      const other = acc.balances.filter((b) => b.asset_type !== "native" && b !== line);
      check(other.length === 0, `${r}: no other asset or trustline`);
    }
    const signIn = (await account(SIGN_IN)).body;
    if (signIn) check(!usdcLine(signIn), `${SIGN_IN_NAME}: no USDC trustline`);
    check(total <= USDC_CAP, `total USDC across the pilot accounts: ${fmt(total)} ≤ 5.0000000 (D7)`);
  }

  if (part === 4 && a.quote && TESTNET) console.log("\n--quote is for mainnet only: the rehearsal takes its USDC from Circle's faucet");
  if (part === 4 && a.quote && !TESTNET) {
    console.log("\nLive DEX quote (Horizon strict-receive paths, XLM → USDC):");
    for (const r of ["buyer", "renter"] as const) {
      const amount = fmt(USDC_PLAN[r]!);
      const q = await get<{ _embedded: { records: { source_amount: string; path: { asset_code?: string; asset_issuer?: string; asset_type: string }[] }[] } }>(
        `/paths/strict-receive?source_assets=native&destination_asset_type=credit_alphanum4&destination_asset_code=USDC&destination_asset_issuer=${USDC_ISSUER}&destination_amount=${amount}`,
      );
      // Only the direct XLM/USDC order book: no path through any other asset.
      const best = q.body?._embedded.records.find((x) => x.path.length === 0);
      if (!best) {
        console.log(`  ${r}: no direct XLM → USDC path found; do not use a path through other assets`);
        continue;
      }
      const sendMax = (units(best.source_amount) * 103n + 99n) / 100n;
      console.log(`  ${r}: ${amount} USDC costs ${best.source_amount} XLM now (direct XLM/USDC book); send-max +3% = ${fmt(sendMax)} XLM`);
      console.log(
        `    stellar tx new path-payment-strict-receive --source-account qs-main-${r} --network mainnet \\\n` +
          `      --send-asset native --send-max ${sendMax} \\\n` +
          `      --destination ${k[r]} --dest-asset USDC:${USDC_ISSUER} --dest-amount ${USDC_PLAN[r]}`,
      );
    }
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

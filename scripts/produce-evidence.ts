/**
 * Produce the testnet evidence for Deliverables 1 and 2, and write docs/evidence.json.
 *
 *   npm run evidence
 *
 * Four transactions, two of which must fail:
 *
 *   1. a **rental** — a transfer carrying an expiry, with issuer approval. Succeeds.
 *   2. a **sale** — the same primitive with no expiry, with issuer approval. Succeeds.
 *   3. the **same sale without issuer approval**. Rejected by the contract.
 *   4. the **issuer trying to seize a held right**. Rejected by the contract.
 *
 * 3 and 4 are the point. Anyone can claim a contract enforces something; these are
 * transactions a reviewer can open in an explorer and see refused. Both are built
 * from a footprint obtained *with* approval and then submitted with the approval
 * removed, so they are well formed enough to be included in a ledger and fail
 * there. A transaction the network rejects at submission would prove nothing —
 * there would be nothing on chain to look at — so this script checks that each
 * rejection actually reached a ledger.
 *
 * The run issues its own rights rather than reusing the published sample
 * inventory, because a sale is permanent: reusing them would make the script work
 * once and fail afterwards. Every run is therefore reproducible from scratch.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { CONTRACT_ID, NETWORK_PASSPHRASE, explorer, issuerSecret } from "../src/lib/config";
import {
  ContractCallError,
  approveTransferAsIssuer,
  buildListTx,
  buildTransferTx,
  prepare,
  prepareUnapprovedTransfer,
  readHolder,
  readHolding,
  readRight,
  server,
  signWith,
  submit,
  type SubmitResult,
} from "../src/lib/contract";
import { isoDateToUnix } from "../src/lib/record";
import { fatal, loadEnv, log, writeJson } from "./lib/cli";
import { evidenceRecord, issueFromRecord } from "./lib/issue";

loadEnv();

const EVIDENCE_OUT = {
  canonical: "inventory/evidence/canonical",
  attestations: "inventory/evidence/attestations",
};

interface EvidenceItem {
  id: string;
  title: string;
  what: string;
  expected: "succeeds" | "rejected by the contract";
  right_id: number;
  hash: string;
  successful: boolean;
  reached_ledger: boolean;
  failure?: string;
  explorer: string;
}

function requireSecret(name: string): Keypair {
  const secret = process.env[name];
  if (!secret) throw new Error(`${name} is not set — see .env.example`);
  return Keypair.fromSecret(secret);
}

async function main(): Promise<void> {
  const issuer = Keypair.fromSecret(issuerSecret());
  const owner = requireSecret("DEMO_OWNER_SECRET");
  const renter = requireSecret("DEMO_RENTER_SECRET");
  const buyer = requireSecret("DEMO_BUYER_SECRET");

  log.step("Cast");
  log.info(`issuer   ${issuer.publicKey()}`);
  log.info(`owner    ${owner.publicKey()}`);
  log.info(`renter   ${renter.publicKey()}`);
  log.info(`buyer    ${buyer.publicKey()}`);
  log.info(`contract ${CONTRACT_ID}`);

  const evidence: EvidenceItem[] = [];

  // --- standing offers, so the app has something to show --------------------

  log.step("Publishing standing offers on the sample inventory");
  for (const [rightId, termSecs, label] of [
    [3, null, "open-ended (sale)"],
    [4, 7 * 86_400, "7-day term (rental)"],
  ] as const) {
    try {
      const tx = await buildListTx({ by: owner.publicKey(), rightId, termSecs });
      const result = await submit(signWith(await prepare(tx), owner));
      if (result.successful) log.ok(`right #${rightId} listed as ${label}`);
      else log.warn(`right #${rightId}: ${result.failure}`);
    } catch (error) {
      // Already listed from an earlier run is the expected steady state, not a
      // failure — the offer is meant to persist.
      const message = error instanceof ContractCallError ? error.message : String(error);
      if (/already listed/i.test(message)) log.info(`right #${rightId} is already listed`);
      else throw error;
    }
  }

  // --- issue the rights this run will act on -------------------------------

  log.step("Issuing three rights for this evidence run");
  const forRental = await issueFromRecord(
    issuer,
    evidenceRecord({
      ownerAccount: owner.publicKey(),
      unit: "Villa 21C",
      checkIn: "2026-10-17",
      checkOut: "2026-10-24",
      useYear: 2026,
      weekNumber: 42,
    }),
    EVIDENCE_OUT,
    "evidence-rental",
  );
  log.ok(`right #${forRental.rightId} for the rental — commitment ${forRental.commitment}`);

  const forSale = await issueFromRecord(
    issuer,
    evidenceRecord({
      ownerAccount: owner.publicKey(),
      unit: "Villa 22A",
      checkIn: "2026-11-07",
      checkOut: "2026-11-14",
      useYear: 2026,
      weekNumber: 45,
    }),
    EVIDENCE_OUT,
    "evidence-sale",
  );
  log.ok(`right #${forSale.rightId} for the sale — commitment ${forSale.commitment}`);

  const forRejection = await issueFromRecord(
    issuer,
    evidenceRecord({
      ownerAccount: owner.publicKey(),
      unit: "Villa 23B",
      checkIn: "2026-12-05",
      checkOut: "2026-12-12",
      useYear: 2026,
      weekNumber: 49,
    }),
    EVIDENCE_OUT,
    "evidence-rejected",
  );
  log.ok(`right #${forRejection.rightId} for the two rejections`);

  // --- 1. rental: the primitive with an expiry -----------------------------

  const rentalExpiry = isoDateToUnix("2026-10-24");
  log.step(`1. Rental — right #${forRental.rightId} to the renter until 2026-10-24`);
  const rentalTx = await buildTransferTx({
    from: owner.publicKey(),
    to: renter.publicKey(),
    rightId: forRental.rightId,
    expiresAt: rentalExpiry,
  });
  const rentalApproved = await approveTransferAsIssuer(rentalTx, issuer);
  log.ok(`issuer approved, valid until ledger ${rentalApproved.validUntilLedger}`);
  await report(evidence, {
    id: "rental",
    title: "Rental — one transfer primitive, carrying a term",
    what:
      `The holder transfers right #${forRental.rightId} to the renter with ` +
      `\`expires_at = ${rentalExpiry}\` (2026-10-24). Title does not move: the renter holds the ` +
      "week until that timestamp, after which it reverts with no return transaction.",
    expected: "succeeds",
    right_id: forRental.rightId,
    result: await submit(signWith(rentalApproved.tx, owner)),
  });

  const holding = await readHolding(forRental.rightId);
  log.ok(`effective holder is now ${holding.holder}, term ends ${holding.expiresAt}`);
  const chain = await readRight(forRental.rightId);
  log.info(
    `holding chain depth ${chain.holdings.length} — title still with ${chain.holdings[0]?.holder}`,
  );

  // --- 2. sale: the same primitive without one -----------------------------

  log.step(`2. Sale — right #${forSale.rightId} to the buyer, open-ended`);
  const saleTx = await buildTransferTx({
    from: owner.publicKey(),
    to: buyer.publicKey(),
    rightId: forSale.rightId,
    expiresAt: null,
  });
  const saleApproved = await approveTransferAsIssuer(saleTx, issuer);
  log.ok(`issuer approved, valid until ledger ${saleApproved.validUntilLedger}`);
  await report(evidence, {
    id: "sale",
    title: "Sale — the same primitive, no term",
    what:
      `The holder transfers right #${forSale.rightId} to the buyer with \`expires_at = None\`. ` +
      "The holding chain collapses to the buyer alone: title moves and the seller keeps no claim.",
    expected: "succeeds",
    right_id: forSale.rightId,
    result: await submit(signWith(saleApproved.tx, owner)),
  });
  log.ok(`title to right #${forSale.rightId} is now ${await readHolder(forSale.rightId)}`);

  // --- 3. the same sale, with the issuer's approval withheld ---------------

  log.step(`3. Sale of right #${forRejection.rightId} without issuer approval — must be rejected`);
  const unapprovedTx = await buildTransferTx({
    from: owner.publicKey(),
    to: buyer.publicKey(),
    rightId: forRejection.rightId,
    expiresAt: null,
  });
  const stripped = await prepareUnapprovedTransfer(unapprovedTx, issuer);
  log.info("issuer authorization entry removed after the footprint was obtained");
  await report(evidence, {
    id: "rejected-no-approval",
    title: "Transfer without issuer approval — rejected on chain",
    what:
      "Identical to the sale above, submitted with the issuer's authorization entry removed. The " +
      "holder signed it and paid the fee; the contract refused it. Verification is enforced in the " +
      "contract, not suggested by the interface.",
    expected: "rejected by the contract",
    right_id: forRejection.rightId,
    result: await submit(signWith(stripped, owner)),
  });
  log.ok(`right #${forRejection.rightId} still held by ${await readHolder(forRejection.rightId)}`);

  // --- 4. the issuer trying to take a week --------------------------------

  log.step(`4. Issuer attempting to seize right #${forRejection.rightId} — must be rejected`);
  // The issuer is the transaction source here: it signs the envelope, pays the
  // fee, and its own approval comes free with being the source account. What it
  // cannot supply is the holder's authorization, which `transfer` requires
  // independently.
  const seizureTx = await buildIssuerSourcedTransfer(
    issuer,
    owner.publicKey(),
    issuer.publicKey(),
    forRejection.rightId,
  );
  await report(evidence, {
    id: "rejected-seizure",
    title: "Issuer attempting to seize a held right — rejected on chain",
    what:
      `The issuer builds, signs, and pays for a transfer of right #${forRejection.rightId} from ` +
      "its holder to itself. It can supply its own approval; it cannot supply the holder's " +
      "authorization. Approving transfers never becomes the power to take one.",
    expected: "rejected by the contract",
    right_id: forRejection.rightId,
    result: await submit(signWith(await prepare(seizureTx), issuer)),
  });
  log.ok(`right #${forRejection.rightId} still held by ${await readHolder(forRejection.rightId)}`);

  // --- write it down -------------------------------------------------------

  writeJson("docs/evidence.json", {
    generated_by: "npm run evidence",
    network: NETWORK_PASSPHRASE,
    contract: CONTRACT_ID,
    contract_explorer: explorer.contract(),
    accounts: {
      issuer: issuer.publicKey(),
      owner: owner.publicKey(),
      renter: renter.publicKey(),
      buyer: buyer.publicKey(),
    },
    rights_issued_for_this_run: {
      rental: { right_id: forRental.rightId, commitment: forRental.commitment, issue_tx: forRental.issueTx },
      sale: { right_id: forSale.rightId, commitment: forSale.commitment, issue_tx: forSale.issueTx },
      rejections: {
        right_id: forRejection.rightId,
        commitment: forRejection.commitment,
        issue_tx: forRejection.issueTx,
      },
    },
    transactions: evidence,
  });
  log.step("Wrote docs/evidence.json");

  const problems = evidence.filter(
    (e) => (e.expected === "succeeds") !== e.successful || !e.reached_ledger,
  );
  if (problems.length > 0) {
    for (const problem of problems) {
      log.fail(`${problem.id}: expected to ${problem.expected}, reached_ledger=${problem.reached_ledger}`);
    }
    process.exitCode = 1;
  } else {
    log.ok("two transfers succeeded, two were rejected, and all four are on the ledger");
  }
}

/**
 * A transfer whose transaction source is the issuer rather than the holder. Only
 * used to demonstrate that it fails.
 */
async function buildIssuerSourcedTransfer(
  issuer: Keypair,
  from: string,
  to: string,
  rightId: number,
): Promise<Transaction> {
  const account = await server.getAccount(issuer.publicKey());
  return new TransactionBuilder(new Account(account.accountId(), account.sequenceNumber()), {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(CONTRACT_ID).call(
        "transfer",
        new Address(from).toScVal(),
        new Address(to).toScVal(),
        nativeToScVal(BigInt(rightId), { type: "u64" }),
        xdr.ScVal.scvVoid(),
      ),
    )
    .setTimeout(180)
    .build();
}

/**
 * Record a result, and confirm it landed on the ledger.
 *
 * A rejected transfer is only evidence if it was *included* and then refused.
 * `reached_ledger` distinguishes that from a transaction the network turned away
 * at submission, whose hash a reviewer could not open.
 */
async function report(
  into: EvidenceItem[],
  item: Omit<EvidenceItem, "hash" | "successful" | "failure" | "explorer" | "reached_ledger"> & {
    result: SubmitResult;
  },
): Promise<void> {
  const { result, ...rest } = item;

  const onLedger = await server
    .getTransaction(result.hash)
    .then((tx) => tx.status !== "NOT_FOUND")
    .catch(() => false);

  into.push({
    ...rest,
    hash: result.hash,
    successful: result.successful,
    reached_ledger: onLedger,
    failure: result.failure,
    explorer: result.explorer,
  });

  const asExpected = (item.expected === "succeeds") === result.successful;
  const verb = result.successful ? "succeeded" : "rejected";
  if (asExpected && onLedger) log.ok(`${verb} on ledger — ${result.hash}`);
  else if (!onLedger) log.fail(`${verb} but never reached a ledger — ${result.hash}`);
  else log.fail(`${verb} — ${result.hash} (expected to ${item.expected})`);

  if (result.failure) log.info(`reason: ${result.failure}`);
  log.link("explorer", result.explorer);
}

main().catch(fatal);

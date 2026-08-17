import Link from "next/link";

import { StandingPanel } from "@/components/StandingPanel";
import { CONTRACT_ID, NETWORK_PASSPHRASE, explorer } from "@/lib/config";

export default function Home() {
  return (
    <>
      <h1>Rent or sell a week you cannot use</h1>
      <p className="lede">
        A timeshare owner who cannot travel this year has no simple way to pass the week on.
        Transfers are slow and broker-dependent, and a buyer cannot easily check who really holds
        the week or whether it carries unpaid maintenance fees. Putting it on a public ledger fixes
        the trust problem and creates a new one — ownership history and travel plans become visible
        to everyone.
      </p>

      <StandingPanel />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>What is on the ledger, and what is not</h3>
        <p style={{ marginTop: 0 }}>
          Personal and ownership records stay off chain. The ledger holds a SHA-256 commitment to
          each record, and an issuer-signed attestation says the week is valid and free of unpaid
          fees. A buyer verifies exactly what needs verifying — that the seller is the authorized
          holder, and that the week is clean — without a name, a document, or a resort ever
          reaching the public ledger.
        </p>
        <p style={{ marginBottom: 0 }}>
          <Link href="/verify">See a verification run end to end →</Link>
        </p>
      </div>

      <h2>One transfer primitive</h2>
      <p>
        There is a single transfer function and it takes a duration. An open-ended transfer is a{" "}
        <strong>sale</strong>. A transfer carrying an expiry is a <strong>rental</strong>. The
        contract checks the holder against the term on every call, so a rental lapses on its own —
        there is no return transaction, and a renter whose week has ended simply stops being the
        holder.
      </p>

      <h2>Who does what — and who approves what</h2>
      <p>
        There is exactly one approval in this system, and it is worth being precise about where it
        sits.
      </p>

      <div className="card tight">
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Who does it</th>
              <th>Who has to approve</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Create a week</td>
              <td>
                The <strong>issuer</strong> — the resort or operator
              </td>
              <td className="muted">Nobody else can do it at all</td>
            </tr>
            <tr>
              <td>Publish an offer</td>
              <td>
                Whoever <strong>holds the week</strong>. An owner may offer it for sale or for rent;
                a renter may only offer a sublet
              </td>
              <td>
                <strong>Nobody.</strong> There is no approval step
              </td>
            </tr>
            <tr>
              <td>Check it before taking it on</td>
              <td>
                The <strong>counterparty</strong>, in their own browser
              </td>
              <td className="muted">Nobody — no account needed</td>
            </tr>
            <tr>
              <td>Rent it out or sell it</td>
              <td>
                The <strong>holder</strong> starts it
              </td>
              <td>
                The <strong>issuer co-signs</strong> — the one approval in the system
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="note accent">
        <strong>Listings are not approved by anyone, deliberately.</strong> If the issuer had to
        approve offers, it could close the market quietly by never approving one. Its veto is
        confined to the moment a week actually changes hands — and even there it can only decline,
        never take. A declined transfer leaves the week exactly where it was.
      </div>

      <h2>The four screens</h2>

      <div className="grid">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            <Link href="/issue">Issue</Link>{" "}
            <span className="tag accent">issuer only</span>
          </h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            The resort commits to an ownership record and creates the usage right. The record is
            hashed, not published. Hidden from everyone else — the contract would refuse them
            anyway.
          </p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            <Link href="/list">List</Link> <span className="tag">open to all</span>
          </h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            The shop window and the public record in one: every week, who holds it, until when, and
            what is on offer. If a week is yours, this is also where you publish or withdraw an
            offer — with nobody&apos;s permission.
          </p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            <Link href="/verify">Verify</Link> <span className="tag">open to all</span>
          </h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            The buyer&apos;s or renter&apos;s screen. Check a disclosed record against the on-chain
            hash and validate the issuer&apos;s attestation, entirely in your own browser. No
            account needed.
          </p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            <Link href="/transfer">Transfer</Link>{" "}
            <span className="tag ok">holders only</span>
          </h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            Rent out or sell, with the issuer&apos;s approval attached. An owner sees both options;
            a renter sees sublet only. Includes a control that submits <em>without</em> approval, so
            you can watch the contract refuse it.
          </p>
        </div>
      </div>

      <h2>What this phase does not claim</h2>
      <div className="note warn">
        Phase 1 rests on a trusted issuer signature, and that is deliberate. A malicious issuer can
        still decline a transfer it should have approved, or attest falsely about a week. What it
        cannot do — because the contract stops it, not because it is trusted not to — is move,
        reassign, freeze, or burn a right that someone already holds. Reducing the reliance on that
        signature with cryptographic proofs is Phase 2's whole purpose and is funded separately.
      </div>

      <h2>This deployment</h2>
      <div className="card tight">
        <dl className="facts">
          <dt>Network</dt>
          <dd>
            <code>{NETWORK_PASSPHRASE}</code>
          </dd>
          <dt>Contract</dt>
          <dd>
            <a href={explorer.contract()} target="_blank" rel="noreferrer">
              <code>{CONTRACT_ID}</code>
            </a>
          </dd>
          <dt>Out of scope</dt>
          <dd className="muted">
            Mainnet, zero-knowledge proofs, swaps, payment and settlement, resort integration, and
            legal title transfer.
          </dd>
        </dl>
      </div>
    </>
  );
}

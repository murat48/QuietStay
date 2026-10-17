import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Reveal } from "@/components/Reveal";
import { SURVEY_URL } from "@/lib/config";
import mark from "../../public/brand/quietstay-mark.png";
import resort from "../../public/images/mediterranean-resort.jpg";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className="landing">
      <section className={styles.hero} aria-labelledby="hero-title">
        <Image
          className={styles.heroImage}
          src={resort}
          alt="A Mediterranean resort pool overlooking the sea and whitewashed Santorini villas"
          fill
          sizes="100vw"
          preload
          placeholder="blur"
        />
        <div className={styles.heroShade} />
        <div className={styles.heroInner}>
          <p className={styles.eyebrow}>A WARM WELCOME TO QUIETSTAY</p>
          <h1 id="hero-title">Your holiday. <br /><span className={styles.headlineAccent}>Your way.</span></h1>
          <p className={styles.description}>
            A simpler way to verify, rent or sell timeshare rights.
            More flexibility for your next getaway, with privacy and trust.
          </p>
          {/*
            Two ways in that need nothing installed. The wallet is asked for
            only when someone acts — from the header, or on the screen where
            they act.
          */}
          <div className={styles.actions}>
            <Link className="btn primary" href="/list">Explore the marketplace</Link>
            <Link className={`btn ${styles.secondaryAction}`} href="/verify">Verify a right</Link>
          </div>
          <p className={styles.heroNote}>No wallet needed to look around.</p>
          <ul className={styles.technology} aria-label="Built with">
            <li><Icon name="transfer" /> Built on Stellar</li>
            <li><Icon name="shield" /> Usage rights proved with ZK</li>
            <li className={styles.testnet}>Testnet MVP · In development</li>
          </ul>
        </div>
      </section>

      <Reveal>
        <section className={styles.intro} id="how-it-works" aria-labelledby="intro-title">
          <div className={styles.introLead}>
            <Image className={styles.introMark} src={mark} alt="" width={72} height={72} />
            <div>
              <p className={styles.sectionEyebrow}>MORE POSSIBILITIES. LESS WORRY.</p>
              <h2 id="intro-title">A fresh start for your vacation rights.</h2>
            </div>
          </div>
          <div className={styles.introCopy}>
            <p>
              QuietStay connects people who want to make more of their timeshare weeks.
              Verify your rights, offer a week for rent or sale, and transfer it with an ownership proof.
            </p>
            <Link href="/verify">Verify a right — no wallet needed <Icon name="arrow" /></Link>
            <p className={styles.phaseNote}>
              ZK proofs are prepared locally today. Full automated integration is planned for Phase 3.
            </p>
          </div>
        </section>
      </Reveal>

      <Reveal className={styles.band}>
        <section className={styles.section} aria-labelledby="steps-title">
          <p className={styles.sectionEyebrow}>HOW IT WORKS</p>
          <h2 id="steps-title" className={styles.sectionTitle}>Rent out or sell your week in four steps.</h2>
          <ol className={styles.steps}>
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className={styles.stepNumber}>{i + 1}</span>
                <span className={styles.stepIcon}><Icon name={step.icon} /></span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </Reveal>

      <Reveal>
        <section className={`${styles.section} ${styles.sides}`} aria-labelledby="sides-title">
          <h2 id="sides-title" className={styles.visuallyHidden}>For owners and for renters</h2>
          {SIDES.map((side) => (
            <div key={side.title} className={styles.side}>
              <p className={styles.sectionEyebrow}>{side.eyebrow}</p>
              <h3>{side.title}</h3>
              <ul>
                {side.points.map((point) => (
                  <li key={point}><Icon name="check" /> {point}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </Reveal>

      <Reveal>
        <section className={styles.survey} aria-labelledby="survey-title">
          <span className={styles.surveyIcon}><Icon name="listing" /></span>
          <div className={styles.surveyCopy}>
            <h2 id="survey-title">Help shape QuietStay</h2>
            <p>
              Own a timeshare, or rented one?
              Five quick questions about how you check who owns a week.
              Two minutes, anonymous unless you leave an email.
            </p>
          </div>
          <a className="btn primary" href={SURVEY_URL} target="_blank" rel="noreferrer">
            Take the survey ↗
          </a>
        </section>
      </Reveal>

      <Reveal>
        <section className={styles.closing} aria-labelledby="closing-title">
          <Image className={styles.closingMark} src={mark} alt="" width={64} height={64} />
          <h2 id="closing-title">Take a look around.</h2>
          <p>
            Browse the weeks on offer, or check any right yourself — no wallet needed to verify.
          </p>
          <div className={styles.closingActions}>
            <Link className="btn primary" href="/list">Explore the marketplace</Link>
            <Link className="btn" href="/verify">Verify a right</Link>
          </div>
          <p className={styles.closingNote}>
            Stellar testnet only. QuietStay transfers usage rights; no payment moves through it yet.
          </p>
        </section>
      </Reveal>
    </div>
  );
}

type IconName = Parameters<typeof Icon>[0]["name"];

const STEPS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "stay",
    title: "Get your week verified",
    text: "The issuer confirms your usage right. Only a sealed fingerprint goes on Stellar — no names, no documents.",
  },
  {
    icon: "listing",
    title: "List it",
    text: "Offer it for rent or for sale. Renters and buyers see the town, the dates and the fee status the issuer attests.",
  },
  {
    icon: "shield",
    title: "Approve with a proof",
    text: "When someone asks, your device creates a proof that the week is yours. It reveals nothing else.",
  },
  {
    icon: "transfer",
    title: "It's theirs",
    text: "The week moves in a single transaction. A rental comes back to you when it ends; a sale makes the buyer the new holder of the usage right, under a key only they hold.",
  },
];

const SIDES = [
  {
    eyebrow: "FOR OWNERS",
    title: "Rent out or sell the week you won't use.",
    points: [
      "Prove you hold the week without sending your contract or ID",
      "No issuer approval for each transfer — your proof is enough",
      "Your week comes back automatically when a rental ends",
    ],
  },
  {
    eyebrow: "FOR RENTERS AND BUYERS",
    title: "Know what you're getting before you commit.",
    points: [
      "See that the seller really holds the week",
      "See the maintenance-fee status the issuer attests",
      "Check any right yourself, with no account needed",
    ],
  },
];

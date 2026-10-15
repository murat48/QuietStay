# QuietStay frontend redesign

Started on `feat/premium-marketplace-ui` and merged to `main` on 2026-10-16.

The referenced screenshot was not available in the conversation. The initial implementation followed the written reference. The revised homepage follows the subsequent request for a simpler vacation introduction and wallet connection: Mediterranean photography, a short headline, one primary connection CTA, and understated Stellar/ZK emphasis. Feature cards and long explanatory sections have been removed.

## Implementation and changed files

| Files | Change |
| --- | --- |
| `src/app/page.tsx`, `src/app/page.module.css` | Simplified responsive vacation homepage, one main wallet CTA, concise introduction, and Stellar/ZK/testnet emphasis with accurate Phase 3 wording. Homepage styles are scoped with plain CSS Modules. |
| `src/app/globals.css` | Navy/blue/white tokens, shared cards and forms, responsive navigation, wrapping for long data, focus indicators, skip link styling, and reduced-motion support. Removed obsolete homepage-only styles and the automatic dark palette. |
| `src/app/layout.tsx` | Branding, metadata, shared footer, and skip-to-content link. Existing wallet provider and button are retained. |
| `src/components/Nav.tsx` | Public Marketplace, My Rights, Verify, and How It Works links on interior pages. The signed-out homepage hides the menu to focus on wallet connection. Original authenticated Issue and role-dependent Transfer links remain available. |
| `src/components/ConnectGate.tsx` | Reused real wallet connection and SEP-10 flow, with concise labels, visible error feedback, and a marketplace link after authentication. |
| `src/components/Icon.tsx` | Small, decorative inline SVG icon set; no icon dependency or UI framework. |
| `src/app/rights/page.tsx`, `src/components/StandingPanel.tsx` | My Rights reuses the existing live account-standing component. Renter explanatory copy now reflects Phase 2 proof requirements. |
| `src/app/{issue,list,verify,transfer}/page.tsx` | Presentation headings and eyebrow labels only; workflow callbacks and authorization are unchanged. |
| `public/images/mediterranean-resort.jpg`, `public/images/CREDITS.md` | Local Unsplash photograph and attribution. Responsive Next.js Image delivery with preload and blur placeholder. |
| `eslint.config.mjs`, `package.json`, `package-lock.json` | Added Next.js ESLint development tooling and `npm run lint`. No new production dependency. The install also refreshed browser compatibility metadata packages `baseline-browser-mapping` and `caniuse-lite`. |

## Functionality and content decisions

- Marketplace routes still require the existing SEP-10 session. Public navigation does not bypass the existing gate.
- Verify remains accessible without a wallet. Hero and feature links navigate to real screens.
- Wallet connectivity, signing, SEP-10, JWT sessions, API routes, contract calls, issuance, listings, buyer consent, and proof handling retain their existing implementations.
- No changes to `src/lib`, `src/app/api`, `contracts`, `circuits`, `WalletProvider`, or `RoleGate`.
- The requested issuer-approval wording conflicts with the current Phase 2 implementation. Copy describes proof-authorized transfers without adding an approval requirement or claiming one exists.
- Names and private records remain off chain, but week dates, addresses, commitments, and transfer details are public. The homepage explains this instead of promising that the full schedule is private.
- Proofs are prepared locally and uploaded. Full automated ZK integration is clearly identified as planned for Phase 3.
- The photo illustrates the destination experience; it is not fabricated marketplace inventory.

## Validation

- `npm run typecheck`: passed.
- `npm run build`: passed on Next.js 16.3.0, with all six frontend routes and existing APIs generated successfully.
- `npm run zk:test`: all 11 circuit tests passed. Existing snarkjs file-handle deprecation warnings were emitted; negative proof tests intentionally print constraint rejection messages.
- `npm run zk:check-bundle`: passed; no repository GPL circuit/proving code entered the browser bundle.
- `cargo test --locked --offline` in `contracts`: all 68 tests passed (62 rights, 6 verifier).
- ESLint on homepage, layout, My Rights, Nav, Icon, and StandingPanel: passed.
- `npm run lint`: 12 existing errors and 1 existing warning in the original issue/list/transfer/verify pages. Compared original `HEAD` content with the final pages using the same ESLint configuration: counts and rule IDs are unchanged. No rules were disabled to hide these findings.
  - Issue: 3 `react-hooks/set-state-in-effect` errors.
  - List: 3 `react-hooks/set-state-in-effect` errors.
  - Transfer: 5 `react-hooks/preserve-manual-memoization` errors.
  - Verify: 1 `react-hooks/set-state-in-effect` error and 1 unused-import warning.
- Chromium reviewed `/`, `/list`, `/rights`, `/verify`, `/issue`, and `/transfer` at 1440, 768, 390, and 320 pixels. All 24 layouts loaded successfully with no document overflow or uncaught page errors. Browser cache returned normal HTTP 304 responses after the first viewport.
- Visually inspected desktop, tablet, mobile, verification, and wallet-picker screenshots. Refined tablet card layout and mobile heading spacing.
- Homepage anchor scrolling and Marketplace navigation/gate passed. The real wallet picker displayed xBull, Albedo, Freighter, Rabet, and Hana. Verify JSON and Verify by id tabs both worked; the verification screen loaded actual testnet right data.

## Verification limits

No browser wallet was authenticated or asked to sign a transaction. Authenticated owner/issuer forms received the shared styles but were not exercised through a signed-in browser session. The state-changing `npm run e2e` was not run: its own instructions require a throwaway contract and disposable inventory, while the configured deployment contains existing rights. Local contract and circuit tests cover protocol behavior without changing that deployment.

The unrelated pre-existing `.claude/settings.local.json`, `docs/KIRALAMA_KILAVUZU.md`, and `phase2.md` changes were left intact.

## Simplified welcome revision

The follow-up welcome-page revision passed TypeScript, lint for all three changed TSX files, and a fresh production build. Chromium checked 1440/768/390/320px: exactly one main CTA, the signed-out header menu hidden, hero image loaded, and no overflow or uncaught errors. The main CTA opened the actual Stellar Wallets Kit; the Verify page retained its navigation. Checks used an isolated production server on port 3001 because port 3000 was already occupied. No backend or transaction logic changed.

## Later revision (2026-10-14)

- **Back to four screens.** The `/rights` (My Rights) route and the "How It Works" link were removed at the owner's request. Navigation is Marketplace (List), Verify, Issue and Transfer. An account's own weeks remain on the List screen's "Yours" tab, and its roles in the header. `StandingPanel` is kept but not mounted.
- **Logo.** The shield mark from `logo.png` (cropped, background made transparent) is in the header, footer and home intro, with a two-tone QUIET/STAY wordmark; it is also the favicon and touch icon.
- **Brand gradients and motion.** Navy, blue and gold from the logo drive buttons, headings, the header hairline and the hero overlay. Every animation stops under `prefers-reduced-motion`.
- **Listing photos.** List cards lead with a representative photo, chosen by the attested country and features; opening a card shows a four-photo gallery beside its facts and actions. Labelled representative throughout; credits in `public/images/CREDITS.md`.

# Interface system

Standard, Advanced, and Light share the same layout rules. New wallet screens use `QgScreen` for the header, scrolling content, and footer. Account screens use `AccountHome` and its single `AccountHome.module.css`, with `AccountBalance`, `VaultHistoryList`, and `VaultLauncher`. Both modes pass balances, supported actions, and account-specific notices into this composition. The shared component owns the header, balance metadata, and action markup. Send screens use `DestinationField` for the labeled address input and scanner, and the `qg-amount-entry` and `qg-review-amount` compositions for amounts.

Security uses `SecurityOverview` and `SecurityOverview.module.css` for its status panel, four interactive tiles, and recovery actions. Standard, Advanced, and Light supply their own key access, backup, limit, and renewal state. Renewal coverage comes from renewal data; service availability alone does not establish that renewals are scheduled.

## Layout and typography

`src/screens/Vault/qg/layout.css` owns geometry and text tokens. The active screen stylesheet consumes these tokens, as do guidance, installation, transaction references, and Light-specific surfaces.

- Use an 8px spacing grid with 4px subdivisions for related labels and controls. Separate sections with `--qg-section-gap`, which adapts to short viewports.
- Use `--qg-gutter` for page alignment. It supplies 24px margins, reduced to 16px below 360px.
- Choose at most three text roles within an ordinary component: heading or value, primary text, and supporting text. The shared type scale uses relative units and three weights.
- Use `qg-field` for labeled inputs and textareas, with `qg-fields` to group them. Editable controls have a visible border and paper surface, 16px input text, and a minimum height of 56px.
- Use the shared field, surface, and dialog radii. Main actions retain pill shapes and an accessible label.
- Keep interactive targets at least 44px high. Keyboard focus uses text or surface cues while preserving control geometry.

Financial amounts retain responsive fitting and tabular numerals. Icons, animation distances, safe areas, and QR codes use dimensions appropriate to their function. Full addresses and transaction references wrap where verification requires the complete value.

## Flow hierarchy

Home presents the balance, payment actions, and activity in that order. Onboarding presents one decision with the information required to make it. Help and expandable guidance contain supporting explanations, while transaction terms, fees, policy consequences, and required confirmations remain accessible in their flow.

Keep ordinary steps contained at 320px and 375px widths, allowing expanded help, history, recovery evidence, and enlarged text to scroll while preserving readable text and touch targets. The primary action belongs in the shared footer, and keyboard focus must reveal the active field within the content area.

## Verification

`src/test/e2e-vault/layout.test.ts` covers small screens in both themes, enlarged text, field contrast, and a short keyboard viewport. The shared `expectWalletLayout` helper checks horizontal overflow and footer access across the existing visual states. Light tests also cover shared payment forms, large balances, and long history. Direct Standard/Light comparisons feed identical empty, funded, pending, and long-history states into the real screens, then compare computed layout and pixels at 320px, 375px, and desktop widths in both themes. History amounts must remain outside the draggable navigation tab’s horizontal path.

Run the unit, type, lint, format, build, and browser checks before a release. Review screenshot changes at mobile and desktop sizes. The CI `refresh_snapshots` input records native Linux baselines with zero pixel tolerance so deliberate changes are captured; ordinary verification retains the existing rasterization tolerance. Local baseline recording can use `VAULT_UPDATE_SNAPSHOTS=1 pnpm test:e2e --update-snapshots`.

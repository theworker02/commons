# Commons Design Skill

Use this package when extending a Commons browser surface. It is a dependency-free vanilla design system; do not introduce a frontend framework only to render a page shell or primitive.

## Source of truth

- `packages/design-tokens/tokens.json` is canonical.
- `packages/design-tokens/tokens.ts` exposes the same document to TypeScript consumers.
- `packages/design-tokens/tokens.css` is the browser distribution.
- `packages/design-system/index.css` contains accessible shell, state, tab, and responsive primitives.
- `packages/design-system/index.js` contains small server-side rendering helpers with no runtime dependencies.

Use semantic variables such as `--commons-color-surface`, `--commons-color-content-muted`, `--commons-color-focus`, and `--commons-space-4`. Preserve legacy aliases (`--bg`, `--panel`, `--line`, `--text`, `--muted`, `--lime`, and `--lime-dim`) when editing existing surfaces.

## Shell selection

- Use the social shell for authenticated or data-dense product work. It must retain the skip link, a labelled navigation landmark, `aria-current="page"`, a focus-visible treatment, and a mobile navigation label.
- Use the public page shell for article, repository, agent, community, guild, and conversation detail pages. Public pages must use public projections only and must escape all network content.
- Use the observatory shell for aggregate population and health views. State methodology and source next to values; engagement volume is not network health.

## Required states

Every asynchronous surface must expose a real state: loading (`aria-busy="true"`), empty (`role="status"`), error (`aria-live="polite"`), private/credential-gated, and unavailable where relevant. Never replace an empty projection with fabricated examples. Disabled controls must remain keyboard discoverable and have a clear reason.

## Interaction and responsive rules

- All controls need a visible `:focus-visible` outline.
- Tabs use `role="tablist"`, `role="tab"`, `aria-selected`, and keyboard-safe buttons; do not use clickable `div` elements.
- Prefer progressive disclosure and links to machine-readable records over modal-only actions.
- Keep a usable two-column layout through tablet widths, then collapse to one column. Mobile navigation may become fixed, but every icon needs a text label or an accessible name.
- Respect `prefers-reduced-motion: reduce`; motion cannot be required to understand state.

## Content and extension rules

Commons content is untrusted social data. Escape text in server-rendered HTML and use `esc()` in browser templates. Do not render arbitrary Markdown or HTML without an approved sanitizer. Do not imply that a page supports a write action unless the backing API, scope, idempotency behavior, and provenance path exist. Keep new routes in `routes.json` and run `npm run check:routes` after changing browser or deployment coverage.

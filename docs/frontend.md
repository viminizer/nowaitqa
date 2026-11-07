# Frontend structure and checks

`web/` remains a React/Vite/TypeScript application. The application root imports one stylesheet;
feature screens compose shared controls and use one validated HTTP/query boundary.

```text
web/src/
  main.tsx               React bootstrap and the only CSS import
  app/                   Providers, shell and lazy route composition
  features/
    runs/                Run list, detail and timeline data
    devices/             Device registration and state
    fixtures/            Cleanup history and recovery
    reliability/         Scenario cohorts and filters
  ui/                    Shared page, form, button, input, select, table and feedback
  lib/                   HTTP/query hooks, navigation and formatting
  styles/
    index.css            The only stylesheet entry point
    tokens.css           Colors, dimensions and typography
    base.css             Element defaults and page-title sizes
    layout.css           Shared application layout
    components/          Shared component styling
```

## Enforced by commands

Run `pnpm lint` before pushing. It runs Biome with warnings treated as failures, then
`pnpm check:ui`. The latter uses the installed TypeScript compiler's AST/resolved module symbols
and PostCSS's declaration tree, rather than searching source text for suspicious words.

- Features import their own files, `ui/`, `lib/`, and the shared API schemas. They cannot import
  another feature's internals. UI cannot import features or application composition; infrastructure
  cannot import UI. Cycles, out-of-tree imports and computed dynamic imports fail.
- Raw page headings, forms, buttons, inputs, visible selects, tables and dialogs are authored in
  `ui/`. Features use shared components, including when renaming a dependency import. Interactive
  ARIA roles cannot be used to recreate those controls in a feature.
- React Aria is imported only by shared UI wrappers. The shared Select keeps its keyboard/focus
  behavior and hidden native form field; the user-facing control is custom styled. Its form fields
  retain existing API names and values.
- Source CSS lives under `styles/`, every stylesheet is imported once by `styles/index.css`, and
  only `main.tsx` imports that entry. Component colors, dimensions and typography reference tokens.
  Named colors, literal fallback values, unknown tokens, `!important`, feature-local CSS and
  injected styles fail. Media-query breakpoints and structural values such as `1fr` remain CSS.
- Page-title tokens cannot exceed 24px desktop or 22px mobile. Page components cannot create a
  second heading-style owner. This establishes compact typography without clipping long content.
- Features use literal classes declared by centralized styles. They cannot override control
  appearance with inline styles or hidden prop spreads. Primitive props also exclude `style`
  and `className`. The sole authored inline-style exception is `TimelineBlock`'s calculated
  `left`/`width` percentages. React Aria's own measured positioning is library behavior.
- Runtime networking and TanStack query hooks are owned by `lib/api.ts`. Native network aliases
  and computed fetch access in a feature are rejected. Public API shapes still come from
  `@nowait/shared` and responses are parsed at the existing shared data hook.
- Direct DOM creation/HTML mutation, dangerous HTML rendering, obvious clock/random reads during
  render, conditional hooks, missing effect dependencies, nested component declarations, index
  keys and explicit `any` in frontend code fail their corresponding checks.
- The HTML shell loads only `main.tsx`; it cannot become another inline-script/style entry point.

Run `pnpm check:ui:selftest` to verify the policy checker itself. It creates disposable source
fixtures, checks real negative and positive cases, exercises the actual Biome overrides and removes
its temporary workspace. These are tooling self-tests, not application scenario tests. CI runs
these in addition to typecheck, lint and the production web build. The `Quality checks` status is
the intended required merge gate.

The TypeScript version is pinned because the installed 7.x release exposes its AST through
`typescript/unstable/*`. A compiler upgrade must pass both the checker and its self-tests.
PostCSS is a development dependency for CSS parsing; React Aria Components supplies UI behavior.

## Still requires browser review

Static checks do not prove visual consistency, meaningful empty states, complete keyboard UX,
correct data denominators, or that a view fits a particular amount of data. Keep server records
in TanStack Query, navigation/filter state in the URL, and transient form/dialog state locally;
derive values instead of copying them into competing stores. Verify these choices in review.

Compare changed screens at desktop and 375px widths, including loading, empty, failed refresh,
pending mutation, keyboard focus and pagination. Compact views should fit ordinary desktop
windows where practical. Long data and small screens must remain accessible: page/inner-table
scrolling and pagination are valid; hiding content to manufacture a no-scroll screenshot is not.

Every dashboard screen follows the approved compact Runs reference: the same sidebar, typography,
paper panels, soft status badges and visible secondary controls. Page and AppShell always use this
layout; Select overlays share its theme. DataPanel, TableFooter, EmptyState and Summary own repeated
composition; the UI checker rejects private copies of their layout classes. Runs uses an
accessible start-run Dialog. Search/status/cursor live in the hash URL; unsubmitted search and
dialog fields stay local. Search and status apply on the server before pagination across all
saved runs. The compact page requests 10 runs; summary counts explicitly describe only that page.
The API still defaults to 50 runs for existing callers and accepts bounded limits of 1–50.
Search is a case-insensitive literal substring of id/build/commit/trigger/platform; SQL wildcard
characters are literal text. Pagination preserves committed filters, and exact final pages have
no spurious older link. Build filename labels omit URL credentials/query strings.

The shared dialog traps/restores focus, offers Escape/outside cancellation, and blocks dismissal
while a start request is pending. Failures keep values and show the shared action error; success
navigates to the durable new run. Hidden native select fields preserve platform/policy submission.
OS coverage is optional and retains existing profile semantics. Device-setup PR45 is
separate and must migrate to these shared boundaries when rebased.

## Changing the rules

Add a shared variant or token when a new need is real, then use it from the feature. Do not silence
a diagnostic or create a private CSS entry point to get a page through CI. Update the shared policy,
self-test and documentation together when the architecture intentionally changes. The project
rulebook remains in private project memory; this document describes executable public conventions.

## Button hierarchy

`Button` and `Link` share the same centralized primary/secondary visual contract. Secondary is the
default: a visible border, surface, consistent padding and height, with hover/pressed/focus states.
Disabled native buttons keep their visible boundary. Primary marks the main action. There is no
quiet text-only button variant.

Use `Link` for navigating actions: Clear filters, pagination, downloads and evidence entry points.
It retains anchor semantics, keyboard activation and open-in-new-tab behavior while looking like a
secondary button. Inline record/scenario references explicitly use `variant="inline"`. Native
anchors in features fail `check:ui`; shared components own rendering. Deciding whether text is an
inline reference or a standalone action still requires review.

## Desktop viewport and table scrolling

Desktop layouts (851px and wider) fill the viewport. Titles, filters, actions and pagination remain
visible; the shared Table owns data scrolling and sticky column headers. Mobile layouts scroll
naturally. Device registration opens a shared dialog; run details use URL-addressable overview,
attempts, coverage and timeline views so large detail sets remain inside tables. Overlays can
scroll internally when needed, independently of the page. Never hide rows or truncate data to fit.

`styles/viewport.css` owns the viewport layout. `check:ui` rejects private scroll containers outside
the shared table/dialog/select owners. Table is a named keyboard-focusable region: its narrowly
scoped Biome noNoninteractiveTabindex exception enables keyboard scrolling, as described in
[MDN overflow accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow#accessibility).
Other files retain the accessibility rule. Browser checks verify desktop document size, actual
table scrolling/header/pagination positions, and natural mobile scrolling.

Phones summarizes registered device contact/activity without claiming execution readiness. Fixtures
and Reliability explicitly scope summary counts to the current page. Reliability preserves each
cohort's full-window denominator and never pools unlike cohorts. Run details separate scenario
outcomes from the saved or derived release gate. Filters, export links, recovery confirmations and
URL views retain their existing behavior. Desktop data tables own scrolling; mobile flows naturally.

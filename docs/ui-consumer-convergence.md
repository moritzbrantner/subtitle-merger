# UI consumer convergence

Subtitle Merger is a real product consumer of `@moritzbrantner/ui`. This document records the
consumer-side contract so UI abstractions are driven by application evidence rather than by the
design-system repository in isolation.

## Current contract

- Declare `@moritzbrantner/ui` directly in the frontend instead of receiving it transitively.
- Use the published Studio theme for editor/creative presentation.
- Import `@moritzbrantner/ui/component-sources.css` whenever package components render.
- Reuse stable UI primitives for generic presentation mechanics such as dialogs, focus trapping,
  buttons, inputs, and labels.
- Keep video loading, subtitle export state, timeline editing, generation, persistence, and backend
  contracts in Subtitle Merger or their existing specialist packages.

## First convergence slice

The video-path and subtitle-export dialogs delegate modal focus management, Escape handling,
outside interaction, and common button/input presentation to the shared UI package. Subtitle Merger
still owns path validation, export-track selection, export format, download execution, localization,
and restoration to the app's File menu.

The subtitle export track selector intentionally remains a native `select`. Its DOM value is part of
the existing browser acceptance contract and there is no product need to trade that simple semantic
control for a richer custom select.

## Consumer findings

1. Timeline Editor still declares `@moritzbrantner/ui ^0.10.0` even though this application is
   converging on UI 1.1.0. The repository-level override temporarily forces one UI implementation so
   the real application can prove compatibility without installing two design-system generations.
   The next compatibility slice should update Timeline Editor's declared range and remove this
   override.
2. Theme CSS and component CSS are separate contracts in UI 1.1.0. A theme-only import is not enough
   once an application renders package components; `component-sources.css` must be explicit.
3. Shared UI should replace generic mechanics, not product semantics. Native or app-owned controls
   remain appropriate when replacing them would only change DOM shape without adding reusable value.

## Evidence

The normal `check` workflow remains the fast merge gate. Browser Acceptance is the product-level
proof: it exercises the real Timeline Editor source graph, opens both application dialogs, generates
and edits subtitles, and exports a downloaded subtitle file. The acceptance run also captures the
export dialog as a screenshot artifact so frontend convergence has visual evidence without adding a
heavy visual lane to the fast path.

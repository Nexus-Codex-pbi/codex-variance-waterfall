# Codex Variance Waterfall — Cert Notes (resubmission wave, Phase 01)

**Version:** 1.0.0.10 (visual.version) · production GUID unchanged (`codexVarianceWaterfall…`) · API 5.11.0 / pbiviz 7.0.2 (pinned).

One-wave AppSource resubmission carrying the transparency/formatting rework, the v2 appearance redesign, **and a confirmed-unshipped axis-title fix**. Partner Center re-evaluates the whole package (Pitfall 6).

## Transparency wave (Plans 05–06)
- New **Background** card: `ColorPicker` fill + 0–100 `transparency` slider via `hexToRGBString`. Additive.
- fx conditional formatting wired on eligible colour properties.

## Title + per-region text wave (Plans 12–13)
- Title + per-region text treatment reworked with adaptive text colour.

## v2 Appearance wave (Plan 17)
- Main solid v2 board look; corner-bracket signature positioned via JS on `options.element`.
- The board's 1a/1b/1c texture variants ("Variations to test") were **not** implemented — must_haves named only the main solid look, so no variant property was added (`settings.ts` / `style/visual.less` unchanged).
- **D-16:** saved colour/fx overrides still resolve.

## High-contrast rule
Shared HC rule wired (`src/shared/highContrast.ts`).

## Pending fixes riding this wave — MUST RIDE
- **`629bee6` — axis title placement fix (v1.0.0.2).** Fully committed and packaged into `CodexVarianceWaterfall_Sample/resubmission-v1.0.0.2/…` (2026-05-19) but **never swapped into the sample root** (root still held v1.0.0.1), i.e. **never submitted**. It ships now — call it out in the Partner Center submission notes.

# Codex Variance Waterfall — Roadmap

## Shipped
- **v1.0.0.1** — current. Pending Partner Center resub 2026-05-17 (sample .pbix rebuilt to embed matching version; previous 1.0.0.0 mismatch resolved).

## Next — v1.0.0.2 — Axis title placement fix

**Issue (observed 2026-05-17):**
- **X-axis title** sits too close to the visual's bottom border. Needs vertical breathing room above the bottom edge AND between the title and the tick values.
- **Y-axis title** renders horizontal (no rotation) AND draws through the chart data area instead of sitting to the left of the tick values.

**Fix scope:**
- Y-axis title: rotate to `-90°` (or `90°` depending on which side is "outside"). Translate left of the tick value column so it sits in the left margin, not overlaying bars.
- X-axis title: add bottom padding to the layout so the title clears the viewport edge. Add a gap between the X-tick label row and the title baseline.
- Recompute the inner plot rect to account for both title margins — title placement should reserve space, not overlap.

**Stretch (format-pane additions, optional):**
- Title rotation toggle for Y axis (90 / -90 / 0) — power users with very short labels may prefer horizontal.
- Title-to-axis spacing slider (px) per axis.

**Constraint:**
- Do NOT branch this until v1.0.0.1 clears Partner Center cert and goes Live. Bundling a new build with a pending resub drags out the review.
- When ready, branch `feat/axis-title-fix` off the cert-passing v1.0.0.1 tag.
- Cert touch-ups: confirm `selectionManager.showContextMenu({}, …)` still fires on axis title regions after the rotate/translate.

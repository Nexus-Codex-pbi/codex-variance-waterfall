# Codex Variance Waterfall — Roadmap

## Shipped
- **v1.0.0.1** — Live on AppSource as of 2026-05-17. Sample .pbix rebuilt to embed matching version; previous 1.0.0.0 mismatch resolved.

## In flight — v1.0.0.2 — Axis title placement fix

Source change landed 2026-05-19 in `src/visual.ts`. Both vertical and horizontal renderers now use explicit padding constants:
- `AXIS_TITLE_TICK_GAP = 10` — gap between tick label row and axis title.
- `AXIS_TITLE_BOTTOM_PAD = 8` — clearance between X-axis title and canvas bottom edge.
- `AXIS_TITLE_LEFT_GAP = 10` — clearance between Y-axis title and the tick value column.

Y-axis title now uses single `translate(x,y) rotate(-90)` transform string with `dominant-baseline: middle` so rotation is robust regardless of d3-attr write order.

**Verify in Power BI Desktop before packaging .pbiviz:**
- X-axis title clears canvas bottom edge with visible breathing room.
- X-axis title has clear gap from tick row above (not crammed against ticks).
- Y-axis title renders rotated -90°, sits in reserved left margin (not over bars).
- Both modes (vertical / horizontal orientation toggle) behave identically.
- `selectionManager.showContextMenu({}, …)` still fires on axis title regions.

**Original issue notes (kept for traceability):**
- X-axis title (v1.0.0.1) sat ~13px from canvas bottom — title baseline math: `plotHeight + axisTitleFontSize + 4` after a margin reservation that didn't account for own title height twice. Verified against source.
- Y-axis title "renders horizontal" claim from parked memory could NOT be reproduced from current source — code applied `rotate(-90)`. Possible field observation was a runtime CSS strip or earlier build. Hardened anyway via single transform string + dominant-baseline.

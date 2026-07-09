# Test Plan – Codex Variance Waterfall

## 1. Functional Tests
- [ ] Visual loads without errors
- [ ] Visual renders with sample data
- [ ] Visual handles empty data gracefully
- [ ] All format pane options apply correctly
- [ ] Selection / cross-filter works (if applicable)
- [ ] Tooltips appear on hover

## 2. Performance Tests
- [ ] update() completes < 250ms
- [ ] No memory leaks
- [ ] Bundle size < 2.5 MB

## 3. Accessibility Tests
- [ ] Keyboard navigation works
- [ ] High contrast mode supported
- [ ] ARIA labels present
- [ ] No flashing content

## 4. Security Tests
- [ ] No external network calls
- [ ] No telemetry
- [ ] No external scripts or fonts
- [ ] No DOM escape or eval

## 5. Packaging Tests
- [ ] pbiviz builds successfully
- [ ] Bundle size < 2.5 MB
- [ ] capabilities.json valid

## 6. Sample PBIX Verification
- [ ] Demonstrates all features
- [ ] Demonstrates formatting options
- [ ] Demonstrates interactions

## 7. Background Transparency (TRANS-01/02/03/05)
- [ ] Background card (Colour + Transparency) appears in the format pane
- [ ] Transparency 0% renders fully opaque background over a non-white report canvas
- [ ] Transparency 50% shows true partial transparency (canvas colour blends through) over a non-white canvas
- [ ] Transparency 100% shows fully transparent background (canvas colour shows through completely)
- [ ] Old saved report (no background properties set) renders pixel-identical to pre-upgrade — no background painted on the SVG (transparency defaults to 100 on this visual specifically since the SVG's background-color was previously only ever set under high contrast, and explicitly cleared to null otherwise, D-06)
- [ ] Light theme and dark theme both render correctly with transparency applied
- [ ] High contrast mode shows no background paint from the new card (pre-existing high-contrast svg style behaviour unchanged)
- [ ] Both Vertical and Horizontal orientations render the background layer correctly

## 8. Conditional Formatting / fx (TRANS-04)
- [ ] fx button appears next to Positive Color swatch in the format pane
- [ ] Binding a measure to a conditional formatting rule on Positive Color changes colour per positive-variance bar
- [ ] Positive bars without a rule fall back to the static Positive Color swatch value
- [ ] Total bars (start/end) and the aggregated "Other" bar continue to use their own static colours (Total Color / Positive or Negative Color), unaffected by the fx rule

## 9. Context Menu Regression (CERT-01)
- [ ] Right-click anywhere within the visual still opens the Power BI context menu after the background transparency change (existing contextmenu listener on `this.target`, unchanged by this plan)

## 10. Visual Title (TITLE-01)
- [ ] Title card appears in the format pane ("Visual Title") with Show Title (off by default), Title Text, Font, Alignment, Font Color
- [ ] Show Title off (default) renders no title text and reserves no extra vertical space — old saved report (no title properties set) is pixel-identical to pre-upgrade (D-06)
- [ ] Show Title on + Title Text set renders the title as a persistent SVG text element above the chart in BOTH Vertical and Horizontal orientation, reserving vertical space (chart shifts down)
- [ ] Title Font (family/size/bold/italic/underline) and Alignment (left/center/right, mapped to text-anchor) apply correctly
- [ ] Title Font Color applies; high contrast mode overrides to the theme foreground colour

## 11. Per-Surface Text Treatment (TEXT-01)
- [ ] Data Labels card: new Font control (Family/Bold/Italic/Underline, reusing existing Font Size) applies to bar value/data labels in both orientations (in-bar and outside-bar placements); Bold off (default) renders the pre-existing font-weight 600
- [ ] Axis & Gridlines card: new Axis Label Font control (Family/Bold/Italic/Underline, reusing existing Axis Label Font Size) applies to X/Y tick labels in both orientations; Bold off (default) renders the pre-existing unset/normal weight
- [ ] Axis titles (showAxisTitles feature) are unchanged (out of this plan's per-surface scope) — still render at hardcoded font-weight 600
- [ ] Bar fill colour logic (Positive/Negative/Total Color) is unaffected — verified unchanged via resolveBarColor()

## 12. Text-Colour fx (TEXT-02)
- [ ] fx button appears next to Value Font Color swatch in the format pane (Data Labels card)
- [ ] Binding a measure to a conditional formatting rule on Value Font Color changes the outside-position bar label colour per category
- [ ] Total/"Other" bars (no real category binding) fall back to the static Value Font Color swatch (or #333 if left empty)
- [ ] Positive Colour fx (pre-existing from TRANS-04) continues to work unchanged, distinct from the new label-colour fx

## 13. Render-Nothing Defaults (D-06)
- [ ] Old saved report with none of the new title/font/alignment properties set renders pixel-identical to pre-upgrade: no title, bar labels at weight 600, axis tick labels at normal weight, all at prior default colours and positions

## 14. Known Pre-Existing Issue (out of scope, logged to deferred-items.md)
- [ ] `npx pbiviz package` logs a non-fatal `ENOENT: en-US/resources.resjson` error during localization packaging; build still completes successfully. Confirmed pre-existing on the pre-plan baseline (reproduces identically before this plan's changes) — not caused by this plan, not fixed here.
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
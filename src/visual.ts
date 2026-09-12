"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import * as d3Selection from "d3-selection";
import * as d3Scale from "d3-scale";
import * as d3Array from "d3-array";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ITooltipService = powerbi.extensibility.ITooltipService;
import ISandboxExtendedColorPalette = powerbi.extensibility.ISandboxExtendedColorPalette;
import ILocalizationManager = powerbi.extensibility.ILocalizationManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import DataView = powerbi.DataView;
import DataViewCategorical = powerbi.DataViewCategorical;

import { dataViewWildcard, dataViewObjects } from "powerbi-visuals-utils-dataviewutils";
import { ColorHelper } from "powerbi-visuals-utils-colorutils";

import { VisualFormattingSettingsModel, textAlignFor } from "./settings";
import { unitScale, clamp } from "./utils";
import { formatModelNumber, numericSections } from "./shared/numberFormat";
import { toRgba, compositeOver, contrastInk, contrastRatio, mutedInk } from "./shared/colorHelpers";
import { Theme, directionColor, accentToken } from "./shared/bandEngine";
import { surfaceTokens, TABULAR_NUMS, mix } from "./shared/designTokens";
import { resolveBorder } from "./shared/borderSettings";
import { makeCornerBrackets, CardSignatureHandle } from "./shared/cardSignature";
import { applyCardSignature } from "./shared/cardSignatureSettings";
import { resolveCodexTheme, neonColorFor, neonFilter, forcedInk, forcedChrome, isFxResolved, ResolvedCodexTheme, flareHexFor } from "./shared/codexThemeSettings";
import { settle } from "./shared/motion";
import { applyHighContrast, statusGlyph, HighContrastResolved } from "./shared/highContrast";
import { LicenseGate } from "./shared/licensing";

type Selection<T extends d3Selection.BaseType> = d3Selection.Selection<T, unknown, null, undefined>;

// ─── v2 board look (01-17): D-16 default sentinels ───────────
// The v2 defaults ship the redesigned look ONLY while the corresponding
// property is still at its original shipped default — any user-set value
// (or fx rule) resolves exactly as before. These are the original
// shipped defaults, used as "untouched" sentinels.
const POSITIVE_COLOR_DEFAULT = "#007064";
const NEGATIVE_COLOR_DEFAULT = "#e60e22";
const TOTAL_COLOR_DEFAULT = "#130064";
const CONNECTOR_COLOR_DEFAULT = "#b4b2a9";

/** Represents one bar in the waterfall */
interface WaterfallBar {
    /** Scale position key — the bar's IDENTITY, never its caption (NEXUS
     *  cycle-14 §3). Derived from the raw category index the row was built
     *  from ("c<index>"), or a reserved token for the generated anchors, so
     *  two bars can share a caption and still own separate bands. */
    key: string;
    label: string;
    value: number;      // the variance amount (or total for start/end)
    cumStart: number;    // y-position bottom of bar
    cumEnd: number;      // y-position top of bar
    type: "total" | "positive" | "negative";
    selectionId: ISelectionId | null;
    categoryIndex: number;   // index in source categories, -1 for totals
}

export class Visual implements IVisual {
    private target: HTMLElement;
    private host: IVisualHost & { allowInteractions?: boolean };
    private eventService: IVisualEventService;
    private selectionManager: ISelectionManager;
    private tooltipService: ITooltipService;
    private colorPalette: ISandboxExtendedColorPalette;
    private localizationManager: ILocalizationManager;
    private isHighContrast: boolean;
    private svg: Selection<SVGSVGElement>;
    private backgroundRect: Selection<SVGRectElement>;
    private borderRect: Selection<SVGRectElement>;
    private titleEl: Selection<SVGTextElement>;
    private chartGroup: Selection<SVGGElement>;
    private formattingSettings = new VisualFormattingSettingsModel();
    private formattingSettingsService: FormattingSettingsService;

    // Current data for tooltip/selection lookups
    private currentBars: WaterfallBar[] = [];
    /** 1180.2.4 — categories dropped this render because their variance was blank
     * or non-numeric. Set during parse, read by the renderer to declare the
     * omission on the canvas. Not the same as a category whose variance is a real
     * zero, which legitimately draws no bar. */
    private unusableCategoryCount = 0;
    private currentDisplayUnits: string = "auto";
    private currentDecimalPlaces: number = 0;
    /** The bound measure's own Power BI format string and the host locale —
     *  the measure semantics every label used to throw away (cycle-14 §6). */
    private modelFormat: string | null = null;
    private hostLocale: string | undefined = undefined;

    // fx (TRANS-04) state
    private categoricalCategories: powerbi.DataViewCategoryColumn | undefined;
    private positiveColorHelper: ColorHelper | null = null;
    private negativeColorHelper: ColorHelper | null = null;
    // fx (TEXT-02) state — bar value/data label colour
    private valueFontColorHelper: ColorHelper | null = null;

    // ─── v2 board look (01-17) state ───────────────────────────
    // Theme + HC resolved once per update(); corner-bracket signature
    // created once (constructor) and re-tinted per render; data signature
    // gates the settle-once motion (§6 — columns settle ONCE, never loop).
    private theme: Theme = "dark";
    private surfaceHex = "#ffffff";
    private surfaceInk = "#000000";
    /** Nexus Codex Theme (#819) — resolved ONCE per update() and threaded
     *  through both renderers, so nothing resolves the mode twice. Auto
     *  reproduces the derivation above exactly; Dark/Light/Neon force it. */
    private codex: ResolvedCodexTheme | null = null;
    private hc: HighContrastResolved = applyHighContrast(null);
    private cornerSignature: CardSignatureHandle | null = null;
    private lastDataSignature: string | null = null;
    private shouldSettle: boolean = false;

    // Margins
    private readonly margin = { top: 24, right: 20, bottom: 60, left: 64 };

    private licenseGate: LicenseGate;

    private lastUpdateOptions: VisualUpdateOptions | null = null;
    private destroyed = false;
    private removeListeners: Array<() => void> = [];


    constructor(options: VisualConstructorOptions) {

        // NO FREE TIER — an unlicensed user gets the whole visual blocked.

        // The check is async, so re-run the last update once it resolves.

        this.licenseGate = new LicenseGate(options.host, () => {

            if (this.lastUpdateOptions) this.update(this.lastUpdateOptions);

        });
        this.formattingSettingsService = new FormattingSettingsService();
        this.target = options.element;
        this.host = options.host;
        this.eventService = options.host.eventService;
        this.selectionManager = options.host.createSelectionManager();
        this.tooltipService = options.host.tooltipService;
        this.colorPalette = options.host.colorPalette as ISandboxExtendedColorPalette;
        this.localizationManager = options.host.createLocalizationManager();
        this.isHighContrast = this.colorPalette.isHighContrast;

        // Context menu on right-click
        this.listen("contextmenu", (e: MouseEvent) => {
            e.preventDefault();
            if (this.host.allowInteractions === false) return;
            const bar = this.findBarFromEvent(e);
            this.selectionManager.showContextMenu(
                bar?.selectionId || {},
                { x: e.clientX, y: e.clientY }
            );
        });

        this.svg = d3Selection.select(this.target)
            .append("svg")
            .classed("variance-waterfall", true);

        // Dedicated background layer (D-05) — persistent SVG rect, first
        // child so it never paints over bars/labels/axes. Never whole-
        // root/target opacity.
        this.backgroundRect = this.svg.append("rect").classed("wf-background", true);

        // Iframe-internal title (Policy 1180.2.5) — persistent SVG text,
        // shown/hidden per update() via showTitle/titleText (D-14).
        this.titleEl = this.svg.append("text").classed("wf-title", true);

        this.borderRect = this.svg.append("rect").classed("wf-border", true).attr("fill", "none").style("pointer-events", "none");
        this.chartGroup = this.svg.append("g").classed("chart-area", true);

        // v2 card signature (01-17): corner brackets created once, after
        // the SVG, so they stay the root's LAST children (paint above the
        // chart). The root needs a positioning context for the absolutely-
        // positioned bracket divs. Re-tinted per update().
        this.target.style.position = "relative";
        this.cornerSignature = makeCornerBrackets(this.target, "#8f8ab8", {
            variant: "cornerBracket",
            mirror: true,
            muted: true,
        });

        // Tooltip on bar hover
        this.listen("mousemove", (e: MouseEvent) => {
            const bar = this.findBarFromEvent(e);
            if (bar) {
                const items: VisualTooltipDataItem[] = [
                    { displayName: bar.label, value: this.formatMeasure(bar.value, this.currentDisplayUnits, this.currentDecimalPlaces) }
                ];
                if (bar.type !== "total") {
                    items.push({ displayName: "Running Total", value: this.formatMeasure(bar.cumEnd, this.currentDisplayUnits, this.currentDecimalPlaces) });
                }
                this.tooltipService.show({
                    coordinates: [e.clientX, e.clientY],
                    isTouchEvent: false,
                    dataItems: items,
                    identities: bar.selectionId ? [bar.selectionId] : []
                });
            } else {
                this.tooltipService.hide({ isTouchEvent: false, immediately: false });
            }
        });
        this.listen("mouseleave", () => {
            this.tooltipService.hide({ isTouchEvent: false, immediately: false });
        });

        // Cross-filtering on bar click
        this.listen("click", (e: MouseEvent) => {
            if (this.host.allowInteractions === false) return;
            const bar = this.findBarFromEvent(e);
            if (bar && bar.selectionId) {
                this.selectionManager.select(bar.selectionId, e.ctrlKey || e.metaKey);
                e.stopPropagation();
            } else if (!bar) {
                this.selectionManager.clear();
            }
        });
        this.listen("keydown", (e: KeyboardEvent) => {
            if (this.host.allowInteractions === false) return;
            const bar = this.findBarFromEvent(e);
            if ((e.key === "Enter" || e.key === " ") && bar?.selectionId) {
                e.preventDefault();
                this.selectionManager.select(bar.selectionId, e.ctrlKey || e.metaKey);
            } else if (e.key === "Escape") {
                e.preventDefault();
                this.selectionManager.clear();
            } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && bar?.selectionId) {
                e.preventDefault();
                const box = (e.target as SVGElement).getBoundingClientRect();
                this.selectionManager.showContextMenu(bar.selectionId, { x: box.x, y: box.bottom });
            }
        });
    }

    private listen<K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void): void {
        this.target.addEventListener(type, handler);
        this.removeListeners.push(() => this.target.removeEventListener(type, handler));
    }

    /**
     * Resolve a bar's fill colour, applying the Positive Colour fx rule
     * (TRANS-04) per-instance for category-linked positive bars via
     * ColorHelper.getColorForMeasure against categoricalCategories.objects.
     * Total bars and the aggregated "Other" bar (categoryIndex -1, no real
     * selectionId) always fall back to the static format-pane values.
     */
    private resolveBarColor(d: WaterfallBar, positiveColor: string, negativeColor: string, totalColor: string): string {
        if (d.type === "total") return totalColor;
        if (d.type === "positive" && d.categoryIndex >= 0 && this.positiveColorHelper) {
            const instanceObjects = this.categoricalCategories?.objects?.[d.categoryIndex];
            return this.positiveColorHelper.getColorForMeasure(instanceObjects, "positiveColor");
        }
        if (d.type === "negative" && d.categoryIndex >= 0 && this.negativeColorHelper) {
            const instanceObjects = this.categoricalCategories?.objects?.[d.categoryIndex];
            return this.negativeColorHelper.getColorForMeasure(instanceObjects, "negativeColor");
        }
        return d.type === "positive" ? positiveColor : negativeColor;
    }

    /**
     * Resolve a bar's OUTSIDE-position value-label colour, applying the
     * Value Font Colour fx rule (TEXT-02) per-instance for category-linked
     * bars via ColorHelper.getColorForMeasure against
     * categoricalCategories.objects. Total/"Other" bars (categoryIndex -1,
     * no real selectionId) always fall back to the static format-pane
     * value (or "#333" if that swatch is left empty — D-06 parity with the
     * pre-existing "leave empty to use auto colour" behaviour).
     */
    private resolveValueFontColor(d: WaterfallBar, customValueColor: string): string {
        if (d.categoryIndex >= 0 && this.valueFontColorHelper) {
            const instanceObjects = this.categoricalCategories?.objects?.[d.categoryIndex];
            const rule = dataViewObjects.getFillColor(instanceObjects, {
                objectName: "labelSettings", propertyName: "valueFontColor"
            });
            // #819 pass 2 — rule 3's fx exemption, on the suite-wide name.
            // A per-instance object is NOT by itself proof of a rule: this
            // card persists a CONSTANT swatch edit through the same wildcard
            // selector (altConstantSelector = undefined, below), so the
            // swatch can arrive on the same field. isFxResolved() separates
            // them — a resolved colour that differs from the pane swatch is
            // DATA and is painted verbatim under every mode; one that equals
            // it is the user's ink and falls through to forcedInk's guard.
            // The empty swatch is this card's "auto" sentinel, and
            // isFxResolved's null-guard reads paneHex === "" as "not fx", so
            // `!customValueColor` carries that case: against an empty swatch
            // a per-instance object can only be a rule.
            if (rule) {
                const resolved = this.valueFontColorHelper.getColorForMeasure(instanceObjects, "valueFontColor");
                if (!customValueColor || isFxResolved(resolved, customValueColor)) return resolved;
            }
        }
        // v2 (01-17): outside value labels ride the direction law (board
        // .wvlab) — lime/magenta for drivers, theme text for anchors —
        // replacing the old flat #333 auto colour. fx rules and a user-set
        // swatch still win.
        let auto = this.surfaceInk;
        if (d.type !== "total") {
            const direction = directionColor(d.type === "positive" ? 1 : -1, this.theme);
            for (let step = 0; step <= 10; step++) {
                const ink = mix(direction, this.surfaceInk, step / 10);
                if (contrastRatio(ink, this.surfaceHex) >= 4.5) { auto = ink; break; }
            }
        }
        // #819 rule 3: an explicitly picked swatch is GUARDED, not replaced —
        // a forced Codex mode keeps it while it still reads on the Codex
        // surface and falls back to the direction ink when it does not. An
        // empty swatch is this card's "default" sentinel ("leave default for
        // auto"). The fx rule above is a DATA colour and still wins outright.
        return this.codex
            ? forcedInk(customValueColor, auto, this.codex, !customValueColor)
            : (customValueColor || auto);
    }

    // ─── v2 board look (01-17) helpers ─────────────────────────

    /** Ensure a <linearGradient> def exists for this base colour; returns
     *  the fill url. Stop formula mirrors the frozen engine's
     *  accentBarGradient() (designTokens — light / base at 45% / dark via
     *  mix()), expressed as SVG stops because a CSS gradient string cannot
     *  fill an SVG rect. Bevel always runs top-to-bottom (board: 180deg in
     *  both orientations). */
    private barFillFor(cache: Map<string, string>, base: string): string {
        let id = cache.get(base);
        if (!id) {
            id = `wf-grad-${base.replace("#", "")}`;
            let defs = this.chartGroup.select<SVGDefsElement>("defs.wf-grads");
            if (defs.empty()) {
                defs = this.chartGroup.append("defs").classed("wf-grads", true);
            }
            const grad = defs.append("linearGradient")
                .attr("id", id)
                .attr("x1", "0").attr("y1", "0").attr("x2", "0").attr("y2", "1");
            grad.append("stop").attr("offset", "0%").attr("stop-color", mix(base, "#ffffff", 0.55));
            grad.append("stop").attr("offset", "40%").attr("stop-color", base);
            grad.append("stop").attr("offset", "100%").attr("stop-color", mix(base, "#000000", 0.7));
            cache.set(base, id);
        }
        return `url(#${id})`;
    }

    /** Draw a column as stacked LED-block segments (v2 signature texture).
     *  orientation "v": blocks stack vertically within [y,y+h]; "h": blocks
     *  run horizontally within [x,x+w]. All blocks carry the column colour
     *  (a waterfall column IS one magnitude — every block lit). */
    private drawQuantisedColumn(
        group: d3Selection.Selection<SVGGElement, WaterfallBar, d3Selection.BaseType, unknown>,
        orientation: "v" | "h",
        x: (d: WaterfallBar) => number, y: (d: WaterfallBar) => number,
        w: (d: WaterfallBar) => number, h: (d: WaterfallBar) => number,
        color: (d: WaterfallBar) => string
    ): void {
        const SEG = 9, GAP = 3;
        group.each((d, i, nodes) => {
            const g = d3Selection.select(nodes[i] as SVGGElement);
            const bx = x(d), by = y(d), bw = w(d), bh = h(d);
            const col = this.isHighContrast ? this.colorPalette.foreground.value : color(d);
            const span = orientation === "v" ? bh : bw;
            if (span <= 0) return;
            const n = Math.max(1, Math.floor((span + GAP) / (SEG + GAP)));
            const segLen = (span - (n - 1) * GAP) / n;
            const glow = this.glowFor(col) || null;
            for (let k = 0; k < n; k++) {
                const off = k * (segLen + GAP);
                const rect = g.append("rect").attr("class", "wf-led")
                    .attr("fill", col).attr("rx", 2).attr("ry", 2);
                if (orientation === "v") {
                    rect.attr("x", bx).attr("y", by + off).attr("width", bw).attr("height", segLen);
                } else {
                    rect.attr("x", bx + off).attr("y", by).attr("width", segLen).attr("height", bh);
                }
                if (glow) rect.style("filter", glow);
            }
            this.settleColumn(g.node() as SVGElement, orientation === "v" ? "scaleY" : "scaleX");
        });
    }

    /** Keep glyphs continuous across LED gaps and the solid bar's bevel. */
    private addLabelBackings(
        groups: d3Selection.Selection<SVGGElement, WaterfallBar, SVGGElement, unknown>,
        inside: (d: WaterfallBar) => boolean,
        color: (d: WaterfallBar) => string
    ): void {
        groups.each((d, index, nodes) => {
            const group = d3Selection.select(nodes[index]);
            const label = group.select<SVGTextElement>(".bar-label").node();
            if (!label || label.style.display === "none" || !inside(d)) return;
            const box = label.getBBox();
            group.insert("rect", ".bar-label")
                .classed("wf-label-backing", true)
                .attr("x", box.x - 2).attr("y", box.y - 1)
                .attr("width", box.width + 4).attr("height", box.height + 2)
                .attr("fill", this.isHighContrast ? this.colorPalette.foreground.value : color(d))
                .style("pointer-events", "none");
        });
    }

    private textWidth(text: string, size: number, family: string, weight = "400"): number {
        const probe = this.svg.append("text")
            .attr("font-size", `${size}px`).attr("font-family", family)
            .style("font-weight", weight).attr("visibility", "hidden").text(text);
        const width = probe.node()?.getComputedTextLength() || 0;
        probe.remove();
        return width;
    }

    /** Truncate by rendered width; the complete caption stays on native hover. */
    private fitText(node: SVGTextElement, width: number): void {
        const full = node.textContent || "";
        if (node.getComputedTextLength() > Math.max(0, width)) {
            let lo = 0, hi = full.length;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                node.textContent = full.slice(0, mid) + "...";
                if (node.getComputedTextLength() <= width) lo = mid;
                else hi = mid - 1;
            }
            node.textContent = full.slice(0, lo) + "...";
            if (node.getComputedTextLength() > width) node.textContent = "";
        }
        d3Selection.select(node).append("title").text(full);
    }

    private fitValueLabels(
        groups: d3Selection.Selection<SVGGElement, WaterfallBar, SVGGElement, unknown>,
        maxWidth: number, maxHeight: number
    ): void {
        groups.select<SVGTextElement>(".bar-label").each((d, index, nodes) => {
            const node = nodes[index], box = node.getBBox();
            const size = parseFloat(node.getAttribute("font-size") || "11");
            const fitted = size * Math.min(1, maxWidth / Math.max(1, box.width), maxHeight / Math.max(1, box.height));
            if (fitted < 6) node.style.display = "none";
            else node.setAttribute("font-size", `${fitted}px`);
        });
    }

    private renderCompact(width: number, height: number): void {
        this.titleEl.style("display", "none");
        this.svg.selectAll(".wf-unusable-notice").remove();
        this.renderEmpty(width, height, "Resize");
    }

    /** Glow filter for driver/anchor columns — dark theme only, never
     *  under HC (§8 drops all glow). Empty string = no filter.
     *
     *  Under Neon this per-MARK halo yields to the group-level flare in
     *  barGroupGlow(): one filter on the `.wf-bar` group glows the column
     *  AND the value label drawn inside it, and stacking both would
     *  double the halo on the same pixels. */
    private glowFor(base: string): string {
        if (this.codex && this.codex.neon) return "";
        return this.hc.active || this.theme === "light"
            ? ""
            : `drop-shadow(0 0 9px color-mix(in srgb, ${base} 50%, transparent))`;
    }

    /** Neon flare on a `.wf-bar` group — the visual's PRIMARY data mark.
     *  #819 rule 1: a column's colour is SEMANTIC (increase / decrease /
     *  anchor), so it is never flare-tinted — under BOTH scopes the halo
     *  is the column's own hue. The flare colour reaches accents only
     *  (the card signature). Axis text, axis titles, gridlines and
     *  connectors are drawn OUTSIDE `.wf-bar` and so never glow.
     *  Empty string = no filter. */
    private barGroupGlow(base: string): string {
        const codex = this.codex;
        if (!codex || !codex.neon || this.hc.active) return "";
        const flare = neonFilter(base, codex.glow);
        return flare === "none" ? "" : flare;
    }

    /** Settle-once motion (§6) on a column — scale-in from its own base,
     *  gated on the data signature so resizes/format tweaks never replay
     *  it. Reduced-motion handled inside the shared settle() helper. */
    private settleColumn(node: SVGElement | null, kind: "scaleX" | "scaleY"): void {
        if (!this.shouldSettle || !node) return;
        node.style.setProperty("transform-box", "fill-box");
        node.style.setProperty("transform-origin", kind === "scaleY" ? "bottom" : "left");
        settle(node, [
            { transform: `${kind}(0.5)`, opacity: 0.4 },
            { transform: `${kind}(1)`, opacity: 1 },
        ], { duration: 400 });
    }

    /** Read the bound identity, independent of DOM order or the hit child. */
    private findBarFromEvent(e: Event): WaterfallBar | null {
        const group = (e.target as Element)?.closest?.(".wf-bar");
        if (!group || !this.chartGroup.node()?.contains(group)) return null;
        return d3Selection.select<Element, WaterfallBar>(group).datum() || null;
    }

    private prepareBarInteractions(): void {
        this.chartGroup.selectAll<SVGGElement, WaterfallBar>(".wf-bar")
            .attr("tabindex", d => this.host.allowInteractions !== false && d.selectionId ? 0 : null)
            .attr("role", d => d.selectionId ? "button" : null)
            .attr("aria-label", d => `${d.label}: ${this.formatMeasure(d.value, this.currentDisplayUnits, this.currentDecimalPlaces)}`)
            .style("--wf-focus", this.isHighContrast ? this.colorPalette.foreground.value : this.surfaceInk)
            .each((d, index, nodes) => {
                const group = d3Selection.select(nodes[index]);
                const box = nodes[index].getBBox();
                group.insert("rect", ":first-child").classed("wf-hit", true)
                    .attr("x", box.x).attr("y", box.y)
                    .attr("width", Math.max(1, box.width)).attr("height", Math.max(1, box.height))
                    .attr("fill", "transparent").style("pointer-events", "all");
            });
    }

    public update(options: VisualUpdateOptions) {
        if (this.destroyed) return;
        this.eventService.renderingStarted(options);
        this.lastUpdateOptions = options;

        if (this.licenseGate.blockedThisFrame()) {
            this.target.style.display = "none";
            this.eventService.renderingFinished(options);
            return;
        }
        this.target.style.display = "";

        try {
        // High contrast mode detection
        this.isHighContrast = this.colorPalette.isHighContrast;

        // Populate settings from dataView
        const dataView: DataView = options.dataViews && options.dataViews[0];
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(
            VisualFormattingSettingsModel, dataView
        );

        // Clear previous render
        this.chartGroup.selectAll("*").remove();
        this.svg.selectAll(".empty-message").remove();
        this.svg.selectAll(".wf-unusable-notice").remove();

        const width = options.viewport.width;
        const height = options.viewport.height;
        this.svg.attr("width", width).attr("height", height);

        // High contrast background
        if (this.isHighContrast) {
            this.svg.style("background-color", this.colorPalette.background.value);
        } else {
            this.svg.style("background-color", null);
        }

        // ─── Dedicated background layer (D-05) ─────────────────────────
        // Suite-wide shared Background card (Colour + Transparency,
        // sourced from _shared/formatting/), painted as a persistent SVG
        // rect (first child, behind `this.chartGroup`) — never whole-
        // root/target opacity; distinct from the pre-existing high-contrast
        // svg style above, which is left untouched. Its transparency
        // default is overridden to 100 in settings.ts specifically so an
        // OLD saved report (this property never previously existed)
        // renders alpha 0 — pixel-identical to painting nothing (D-06) —
        // while still exposing a real, working Colour + Transparency
        // control.
        this.backgroundRect.attr("width", width).attr("height", height);
        const background = this.formattingSettings.background;
        const bgHex = background.backgroundColor.value?.value ?? "#ffffff";
        const bgTransparencyPct = background.transparency.value ?? 100;
        const paletteBg = (this.colorPalette && (this.colorPalette as any).background && (this.colorPalette as any).background.value) || "#ffffff";

        // ─── The ONE theme derivation (v2 board look 01-17) ────────────
        // Composite the Background fill over whatever the page puts behind
        // it and read the tone. This is the AUTO answer — the shipped 1.x
        // behaviour, and the control the Codex card must reproduce byte
        // for byte.
        const autoSurfaceHex = compositeOver(bgHex, bgTransparencyPct, paletteBg);
        const autoTheme: Theme = contrastInk(autoSurfaceHex, "#000000", "#ffffff") === "#000000" ? "light" : "dark";
        this.hc = applyHighContrast(this.colorPalette, {
            fallbackColor: this.formattingSettings.waterfallCard.positiveColor.value.value,
        });

        // ─── Nexus Codex Theme (#819): a mode switch ABOVE that pick ───
        // Auto returns exactly the values derived above. Dark/Light/Neon
        // paint the Codex card surface at the card's OWN Surface
        // Transparency instead of the user's Background colour, and force
        // the token set. High contrast already collapsed to Auto inside
        // the resolver — no HC branch of our own.
        const codex = resolveCodexTheme(this.formattingSettings.codexTheme, {
            hcActive: this.hc.active,
            autoTheme,
            autoBgHex: bgHex,
            autoTransparencyPct: bgTransparencyPct,
            behindHex: paletteBg,
        });
        this.codex = codex;
        // A forced mode OWNS the inks it paints against its own surface:
        // an axis grey chosen for a white card is not a choice about the
        // Codex dark surface. Bar fills (direction law, user swatches, fx
        // rules) stay the user's.
        const inkOverride = codex.mode !== "auto";

        if (this.isHighContrast) {
            this.backgroundRect.attr("fill", "none");
        } else {
            this.backgroundRect.attr("fill", toRgba(codex.bgHex, codex.transparencyPct));
        }

        // Visual's own Border card — SVG stroke-rect inset by half the
        // stroke so it sits fully inside the canvas; raised above content.
        const rb = resolveBorder(this.formattingSettings.visualBorder, {
            hcActive: this.isHighContrast,
            hcColor: this.colorPalette.foreground.value,
            palette: this.colorPalette,
            metadataObjects: options.dataViews?.[0]?.metadata?.objects,
        });
        this.svg.node()?.appendChild(this.borderRect.node() as Node); // keep on top
        if (rb) {
            const inset = rb.width / 2;
            this.borderRect
                .attr("x", inset).attr("y", inset)
                .attr("width", Math.max(0, width - rb.width))
                .attr("height", Math.max(0, height - rb.width))
                .attr("rx", rb.radius).attr("ry", rb.radius)
                .attr("stroke", rb.colorCss).attr("stroke-width", rb.width)
                .style("display", "");
        } else {
            this.borderRect.style("display", "none");
        }

        // ─── v2 board look (01-17): the surface every ink is judged
        // against. In Auto these three are identical to the pre-#819
        // values (codex.surfaceHex === autoSurfaceHex, codex.theme ===
        // autoTheme); a forced mode swaps in the Codex surface so every
        // adaptive ink downstream re-reads against what the viewer sees.
        this.surfaceHex = codex.surfaceHex;
        this.surfaceInk = contrastInk(this.surfaceHex, "#000000", "#ffffff");
        this.theme = codex.theme;

        // Corner-bracket signature — accent (cyan) tinted per the board;
        // glow only on the dark theme, never under HC. Under Neon the
        // glow budget becomes the card's. The flare colour reaches the
        // bracket only through the AUTO slot: a report that turned Auto
        // Colour off and picked its own accent keeps that accent (the
        // shared resolver's precedence, mirrored from the KPI pilot).
        applyCardSignature(this.cornerSignature, this.formattingSettings.cardSignature, {
            autoHex: neonColorFor(accentToken(this.theme), codex),
            flareHex: flareHexFor(codex),
            hcActive: this.hc.active,
            hcColor: this.hc.color,
            glowMix: this.hc.active ? 0 : codex.neon ? codex.glow : (this.theme === "light" ? 0 : 50),
            muted: false,
        });

        // ─── Visual Title (iframe-internal, Policy 1180.2.5) ───────────
        // Reserves vertical space above the chart when shown; `titleH` is
        // threaded into renderVertical/renderHorizontal's top margin.
        const titleFmt = this.formattingSettings.titleSettings;
        const showTitle = !!titleFmt.showTitle.value && !!titleFmt.titleText.value;
        const titleFontSize = titleFmt.titleFontSize.value || 14;
        const titleH = showTitle ? titleFontSize + 12 : 0;
        if (showTitle) {
            const tAlign = textAlignFor(String((titleFmt as any).titleAlign?.value || "left"));
            const x = tAlign === "center" ? width / 2 : tAlign === "right" ? width - 8 : 8;
            const anchor = tAlign === "center" ? "middle" : tAlign === "right" ? "end" : "start";
            // Adaptive default (D-16 sentinel): untouched shared-Title navy
            // swaps to the dark text token on dark surfaces. #819 rule 3: a
            // forced mode keeps an explicitly picked title ink while it reads
            // on the Codex surface, instead of discarding it outright.
            const setTitle = titleFmt.titleColor.value.value;
            const adaptiveTitle = forcedInk(setTitle, this.surfaceInk, codex, setTitle === "#1a1a2e");
            this.titleEl
                .attr("x", x)
                .attr("y", titleFontSize + 4)
                .attr("text-anchor", anchor)
                .style("font-family", titleFmt.titleFontFamily.value || "Segoe UI, sans-serif")
                .style("font-size", `${titleFontSize}px`)
                .style("font-weight", titleFmt.titleBold.value ? "700" : "400")
                .style("font-style", titleFmt.titleItalic.value ? "italic" : "normal")
                .style("text-decoration", titleFmt.titleUnderline.value ? "underline" : "none")
                .style("fill", this.isHighContrast ? this.colorPalette.foreground.value : adaptiveTitle)
                .text(String(titleFmt.titleText.value))
                .style("display", null);
            this.fitText(this.titleEl.node() as SVGTextElement, Math.max(0, width - 16));
        } else {
            this.titleEl.style("display", "none");
        }

        // Validate data
        if (!dataView || !dataView.categorical || !dataView.categorical.categories
            || !dataView.categorical.categories.length
            || !dataView.categorical.values || !dataView.categorical.values.length) {
            this.renderEmpty(width, height);
            this.eventService.renderingFinished(options);
            return;
        }

        const categorical: DataViewCategorical = dataView.categorical;
        const categories = categorical.categories[0].values as string[];
        this.categoricalCategories = categorical.categories[0];

        // A bound category column carrying ZERO rows is empty input, not a
        // waterfall of length zero. The guard above only rejects a missing
        // category COLUMN, so a present-but-empty values array fell through and
        // drew two anchors at 0 — a fabricated opening and closing balance for a
        // query that returned nothing (NEXUS cycle-14 §2).
        if (!categories.length) {
            this.renderEmpty(width, height);
            this.eventService.renderingFinished(options);
            return;
        }

        // Find startValue and variance columns by role
        let startValueCol: powerbi.DataViewValueColumn | null = null;
        let varianceCol: powerbi.DataViewValueColumn | null = null;

        for (const col of categorical.values) {
            const roles = col.source.roles;
            if (roles && roles["startValue"]) startValueCol = col;
            if (roles && roles["variance"]) varianceCol = col;
        }

        if (!varianceCol) {
            this.renderEmpty(width, height);
            this.eventService.renderingFinished(options);
            return;
        }

        // The measure's own format string and the host locale (cycle-14 §6).
        // Variance is the measure the chart is about; the opening balance's
        // format is the fallback when only that one carries one.
        this.modelFormat = (varianceCol.source.format || (startValueCol && startValueCol.source.format)) || null;
        this.hostLocale = this.host.locale || undefined;

        // Extract settings
        const wf = this.formattingSettings.waterfallCard;
        const sort = this.formattingSettings.sortCard;
        const lbl = this.formattingSettings.labelCard;

        // ─── v2 board look (01-17): the direction law + cyan anchors ───
        // D-16 ladder per colour: a user-set swatch resolves exactly as
        // before; only the untouched shipped default hands over to the
        // shared engine — increases locked to lime, decreases to magenta
        // (directionColor, §2 — reserved for direction only), anchors/
        // subtotals in cyan (accentToken — never a driver colour).
        const positiveColor = wf.positiveColor.value.value !== POSITIVE_COLOR_DEFAULT
            ? wf.positiveColor.value.value
            : directionColor(1, this.theme);
        const negativeColor = wf.negativeColor.value.value !== NEGATIVE_COLOR_DEFAULT
            ? wf.negativeColor.value.value
            : directionColor(-1, this.theme);
        const totalColor = wf.totalColor.value.value !== TOTAL_COLOR_DEFAULT
            ? wf.totalColor.value.value
            : accentToken(this.theme);
        const showConnectors = wf.connectorLine.value;
        // Connectors: 1.5px hairlines in the muted foreground (board) —
        // chrome, so a forced mode's default is that mode's own muted token
        // (#819 rule 2); an explicitly set Connector Color is GUARDED by the
        // chrome bar, not the ink bar (#819 pass 2): a hairline only has to
        // separate from the surface (≥ 1.3:1), not be readable at 4.5:1.
        // The untouched default stays outside the helper because
        // forcedChrome's Auto branch returns the user's hex verbatim and so
        // cannot express this repo's adaptive "swap to the mode token while
        // untouched" default (D-16).
        const setConnector = wf.connectorColor.value.value;
        const connectorDefault = surfaceTokens(this.theme).muted;
        const connectorColor = setConnector === CONNECTOR_COLOR_DEFAULT
            ? connectorDefault
            : forcedChrome(setConnector, connectorDefault, codex, false);
        const showEndTotal = wf.showEndTotal.value;
        const startLabel = wf.startLabel.value || "Forecast";
        const endLabel = wf.endLabel.value || "Actual";
        const barWidthRatio = clamp(wf.barWidth.value, 0.1, 1.0);

        const sortBy = String(sort.sortBy.value?.value || "variance_desc");
        const maxCategories = Math.max(1, Math.floor(sort.maxCategories.value || 10));

        const showValues = lbl.showValues.value;
        const valuePosition = String(lbl.valuePosition.value?.value || "auto");
        const fontSize = clamp(lbl.fontSize.value || 11, 6, 30);
        const displayUnits = String(lbl.displayUnits.value?.value || "auto");
        const decimalPlaces = clamp(lbl.decimalPlaces.value ?? 0, 0, 6);
        const customValueColor = lbl.valueFontColor.value.value;

        // Axis & gridline settings
        const ax = this.formattingSettings.axisCard;
        const showAxisLabels = ax.showAxisLabels.value;
        // Adaptive defaults (D-16): the three static light-grey axis
        // defaults would vanish on a dark surface — swap to dark tokens
        // while untouched; any user pick wins.
        // #819 rule 3: "adapt while untouched" becomes "the mode default
        // while untouched, the report's own ink while it still READS on the
        // Codex surface" — a forced mode guards the axis furniture it paints
        // against its own surface rather than discarding it.
        const setAxisLabel = ax.axisLabelColor.value.value;
        const axisLabelColor = forcedInk(setAxisLabel, mutedInk(this.surfaceInk, this.surfaceHex), codex,
            setAxisLabel === "#5e5d5a");
        const axisLabelFontSize = clamp(ax.axisLabelFontSize.value || 10, 6, 30);
        // #819 rule 2: gridlines and axis lines are CHROME — under a forced
        // mode their default comes from that mode's own surface tokens, not
        // from the cream/taupe pair authored for the board's light look.
        // #819 pass 2: both have a picker behind them, so an explicitly set
        // colour is guarded by forcedChrome's ≥ 1.3:1 SEPARATION bar rather
        // than forcedInk's 4.5:1 readability bar — furniture only has to be
        // visible. The untouched default stays outside the helper (see the
        // Connector Color note above: forcedChrome's Auto branch cannot
        // express D-16's adaptive default).
        const setGridline = ax.gridlineColor.value.value;
        const gridlineDefault = this.theme === "dark" ? "rgba(143,138,184,0.28)"
            : inkOverride ? surfaceTokens("light").track : "#e8e2d3";
        const gridlineColor = setGridline === "#e8e2d3"
            ? gridlineDefault
            : forcedChrome(setGridline, gridlineDefault, codex, false);
        const gridlineWidth = Math.max(0.1, ax.gridlineWidth.value);
        const showGridlines = ax.showGridlines.value;
        const setAxisLine = ax.axisLineColor.value.value;
        const axisLineDefault = this.theme === "dark" ? surfaceTokens("dark").muted
            : inkOverride ? surfaceTokens("light").muted : "#b4b2a9";
        const axisLineColor = setAxisLine === "#b4b2a9"
            ? axisLineDefault
            : forcedChrome(setAxisLine, axisLineDefault, codex, false);
        const showAxisTitles = ax.showAxisTitles.value;
        const xAxisTitle = ax.xAxisTitle.value || "";
        const yAxisTitle = ax.yAxisTitle.value || "";

        // ─── Text treatment (font family/weight/style/decoration,
        // TEXT-01/TEXT-02) — each `?? default` fallback reproduces this
        // visual's PRE-EXISTING hardcoded style exactly when an old saved
        // report has none of these new properties set (D-06):
        //   bar value/data label: was hardcoded font-weight 600 -> bold defaults true
        //   axis/category tick label: no font-weight was ever set (normal) -> axisLabelBold defaults false
        // "Bold" renders 700; "not bold" renders each surface's own
        // pre-existing rest-weight, not a flat 400.
        const weightFor = (bold: boolean | undefined, restWeight: string): string => bold ? "700" : restWeight;

        const valueFontFamily = lbl.fontFamily.value || "Segoe UI, Tahoma, Geneva, Verdana, sans-serif";
        const valueWeight = weightFor(lbl.bold.value, "400");
        const valueStyle = lbl.italic.value ? "italic" : "normal";
        const valueDecoration = lbl.underline.value ? "underline" : "none";

        const axisLabelFontFamily = ax.axisLabelFontFamily.value || "Segoe UI, Tahoma, Geneva, Verdana, sans-serif";
        const axisLabelWeight = weightFor(ax.axisLabelBold.value, "400");
        const axisLabelStyle = ax.axisLabelItalic.value ? "italic" : "normal";
        const axisLabelDecoration = ax.axisLabelUnderline.value ? "underline" : "none";

        // 1180.2.4 Data Types — `Number(x) || 0` is the worst available coercion
        // here. Number(null) and Number("") are both 0, Number("n/a") is NaN which
        // `||` also turns into 0, and `||` swallows a legitimate 0 as well. Every
        // one of those collapsed to zero, and the `v !== 0` filter below then
        // DELETED the category from the waterfall — no bar, no gap, no notice, just
        // a driver silently missing from a chart whose whole job is accounting for
        // a total. Blank and non-numeric are now distinguished from a real zero.
        const asNumberOrNull = (raw: unknown): number | null => {
            if (raw === null || raw === undefined) return null;
            if (typeof raw === "string" && raw.trim() === "") return null;
            const n = typeof raw === "number" ? raw : Number(raw);
            return Number.isFinite(n) ? n : null;
        };

        // Build category-variance pairs
        //
        // The opening balance is the ONE number every other position in a
        // waterfall is measured from, so a missing one cannot be defaulted the
        // way an absent field can (NEXUS cycle-14 §2):
        //   - Start Value role NOT bound  -> documented zero baseline, unchanged.
        //   - Start Value role bound, first reading blank/non-numeric -> a
        //     MISSING MEASUREMENT. `?? 0` asserted an opening of 0, which drew a
        //     zero anchor, re-based every driver against it and closed the chart
        //     on a total that was never in the model. No baseline, no bridge:
        //     the visual says so instead of inventing one.
        const boundOpening: number | null = startValueCol
            ? asNumberOrNull(startValueCol.values[0])
            : null;
        if (startValueCol && boundOpening === null) {
            this.renderEmpty(width, height, this.localizationManager.getDisplayName("Empty_NoOpening")
                || "Start Value has no numeric opening balance for this selection — the waterfall cannot be based.");
            this.eventService.renderingFinished(options);
            return;
        }
        const startValue: number = boundOpening ?? 0;
        if (startValueCol && categories.some((_, index) =>
            asNumberOrNull(startValueCol.values[index]) !== startValue)) {
            this.renderEmpty(width, height,
                "Start Value must contain the same numeric opening balance for every category.");
            this.eventService.renderingFinished(options);
            return;
        }

        interface CatVar { cat: string; variance: number; catIndex: number; }
        let items: CatVar[] = [];
        this.unusableCategoryCount = 0;
        for (let i = 0; i < categories.length; i++) {
            const v = asNumberOrNull(varianceCol.values[i]);
            if (v === null) {
                // Blank or non-numeric: genuinely nothing to plot, but it is NOT a
                // zero contribution. Counted so the reader can be told.
                this.unusableCategoryCount++;
                continue;
            }
            // A real 0 still contributes no bar to a waterfall, which is correct —
            // but it is now distinguishable from missing data.
            if (v !== 0) {
                items.push({ cat: categories[i] == null ? "" : String(categories[i]), variance: v, catIndex: i });
            }
        }

        // Sort
        switch (sortBy) {
            case "variance_desc":
                items.sort((a, b) => b.variance - a.variance);
                break;
            case "variance_asc":
                items.sort((a, b) => a.variance - b.variance);
                break;
            case "category":
                items.sort((a, b) => a.cat.localeCompare(b.cat));
                break;
            case "absolute_desc":
                items.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
                break;
        }

        // Group overflow into "Other"
        if (items.length > maxCategories) {
            const visible = items.slice(0, maxCategories);
            const remainder = items.slice(maxCategories);
            const otherSum = remainder.reduce((s, r) => s + r.variance, 0);
            visible.push({ cat: this.localizationManager.getDisplayName("Overflow_Other") || "Other", variance: otherSum, catIndex: -1 });
            items = visible;
        }

        // Build waterfall bars with cumulative positions
        const bars: WaterfallBar[] = [];

        // Start total bar: from 0 to startValue
        bars.push({
            key: "#start",
            label: startLabel,
            value: startValue,
            cumStart: 0,
            cumEnd: startValue,
            type: "total",
            selectionId: null,
            categoryIndex: -1
        });

        // Variance bars
        let running = startValue;
        for (const item of items) {
            const prev = running;
            running += item.variance;
            const selId = item.catIndex >= 0
                ? this.host.createSelectionIdBuilder()
                    .withCategory(categorical.categories[0], item.catIndex)
                    .createSelectionId()
                : null;
            bars.push({
                // Identity, not caption: the raw source index this row was
                // built from survives sorting, and the aggregated overflow bar
                // (catIndex -1) gets its own reserved token.
                key: item.catIndex >= 0 ? `c${item.catIndex}` : "#other",
                label: item.cat,
                value: item.variance,
                cumStart: prev,
                cumEnd: running,
                type: item.variance >= 0 ? "positive" : "negative",
                selectionId: selId,
                categoryIndex: item.catIndex
            });
        }

        // End total bar
        if (showEndTotal) {
            bars.push({
                key: "#end",
                label: endLabel,
                value: running,
                cumStart: 0,
                cumEnd: running,
                type: "total",
                selectionId: null,
                categoryIndex: -1
            });
        }

        // Store for tooltip/selection event handlers
        this.currentBars = bars;
        this.currentDisplayUnits = displayUnits;
        this.currentDecimalPlaces = decimalPlaces;

        // ─── Conditional formatting (fx) wiring — Positive Colour
        // (TRANS-04). A bare `instanceKind: ConstantOrRule` declaration in
        // settings.ts does not make the fx button functional on its own —
        // it also needs a `selector` (dataViewWildcard, so a rule can match
        // this measure's category instances/totals) and an
        // `altConstantSelector` bound to a concrete selectionId for the
        // "set for all" swatch edit path. Resolved per-bar at render via
        // ColorHelper.getColorForMeasure against each category's own
        // per-instance object overrides (categoricalCategories.objects[categoryIndex]),
        // via resolveBarColor() below.
        const firstDataBar = bars.find(b => b.selectionId);
        wf.positiveColor.selector = dataViewWildcard.createDataViewWildcardSelector(
            dataViewWildcard.DataViewWildcardMatchingOption.InstancesAndTotals
        );
        wf.positiveColor.altConstantSelector = undefined; // card-level constant persistence: swatch edits apply to ALL instances + round-trip into the pane (first-instance binding persisted a row-0-only override); fx rules stay per-instance via the wildcard selector;
        this.positiveColorHelper = new ColorHelper(
            this.host.colorPalette,
            { objectName: "waterfallSettings", propertyName: "positiveColor" },
            // v2 (01-17): the helper's no-override fallback is the
            // D-16-resolved positive colour (lime when the swatch is at its
            // shipped default), so the fx ladder stays: rule > swatch > law.
            positiveColor
        );
        wf.negativeColor.selector = dataViewWildcard.createDataViewWildcardSelector(
            dataViewWildcard.DataViewWildcardMatchingOption.InstancesAndTotals
        );
        wf.negativeColor.altConstantSelector = undefined;
        this.negativeColorHelper = new ColorHelper(
            this.host.colorPalette,
            { objectName: "waterfallSettings", propertyName: "negativeColor" },
            negativeColor
        );

        // ─── Conditional formatting (fx) wiring — Bar Value/Data Label
        // Colour (TEXT-02). Same wildcard-selector + altConstantSelector +
        // ColorHelper.getColorForMeasure pattern as Positive Colour above,
        // resolved per-bar against each category's own per-instance object
        // overrides (categoryIndex -1 for total/"Other" bars falls back to
        // the static swatch — no real category to bind a rule against).
        lbl.valueFontColor.selector = dataViewWildcard.createDataViewWildcardSelector(
            dataViewWildcard.DataViewWildcardMatchingOption.InstancesAndTotals
        );
        lbl.valueFontColor.altConstantSelector = undefined; // card-level constant persistence: swatch edits apply to ALL instances + round-trip into the pane (first-instance binding persisted a row-0-only override); fx rules stay per-instance via the wildcard selector;
        this.valueFontColorHelper = new ColorHelper(
            this.host.colorPalette,
            { objectName: "labelSettings", propertyName: "valueFontColor" },
            lbl.valueFontColor.value.value
        );

        // v2 motion gate (§6): columns settle ONCE per data change — a
        // resize/format-pane update re-renders without replaying it.
        const dataSignature = bars.map((b) => `${b.label}:${b.value}`).join("|");
        this.shouldSettle = dataSignature !== this.lastDataSignature;
        this.lastDataSignature = dataSignature;

        const orientation = String(wf.orientation.value?.value || "vertical");
        const noticeHeight = this.unusableCategoryCount > 0 ? 20 : 0;
        if (noticeHeight) {
            const count = this.unusableCategoryCount;
            this.svg.append("text")
                .classed("wf-unusable-notice", true)
                .attr("x", 8).attr("y", titleH + 14)
                .attr("font-size", "11px")
                .attr("fill", this.isHighContrast ? this.colorPalette.foreground.value : axisLabelColor)
                .text(`${count} ${count === 1 ? "category" : "categories"} omitted - no numeric value; totals are partial`);
        }

        if (orientation === "horizontal") {
            this.renderHorizontal(bars, width, height, barWidthRatio,
                positiveColor, negativeColor, totalColor,
                showConnectors, connectorColor,
                showValues, valuePosition, fontSize, displayUnits, decimalPlaces,
                customValueColor, showAxisLabels, axisLabelColor, axisLabelFontSize,
                gridlineColor, gridlineWidth, showGridlines, axisLineColor,
                showAxisTitles, xAxisTitle, yAxisTitle, titleH + noticeHeight,
                valueFontFamily, valueWeight, valueStyle, valueDecoration,
                axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
        } else {
            this.renderVertical(bars, width, height, barWidthRatio,
                positiveColor, negativeColor, totalColor,
                showConnectors, connectorColor,
                showValues, valuePosition, fontSize, displayUnits, decimalPlaces,
                customValueColor, showAxisLabels, axisLabelColor, axisLabelFontSize,
                gridlineColor, gridlineWidth, showGridlines, axisLineColor,
                showAxisTitles, xAxisTitle, yAxisTitle, titleH + noticeHeight,
                valueFontFamily, valueWeight, valueStyle, valueDecoration,
                axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
        }
        this.prepareBarInteractions();

        this.eventService.renderingFinished(options);
        } catch (e) {
            this.eventService.renderingFailed(options, String(e));
        }
    }

    private renderVertical(
        bars: WaterfallBar[], width: number, height: number, barWidthRatio: number,
        positiveColor: string, negativeColor: string, totalColor: string,
        showConnectors: boolean, connectorColor: string,
        showValues: boolean, valuePosition: string, fontSize: number,
        displayUnits: string, decimalPlaces: number,
        customValueColor: string, showAxisLabels: boolean, axisLabelColor: string, axisLabelFontSize: number,
        gridlineColor: string, gridlineWidth: number, showGridlines: boolean, axisLineColor: string,
        showAxisTitles: boolean, xAxisTitle: string, yAxisTitle: string, titleH: number,
        valueFontFamily: string, valueWeight: string, valueStyle: string, valueDecoration: string,
        axisLabelFontFamily: string, axisLabelWeight: string, axisLabelStyle: string, axisLabelDecoration: string
    ): void {
        // In vertical mode: X = categories, Y = values
        const axisTitleFontSize = axisLabelFontSize + 2;
        // Reserve: title height + gap from tick row above + bottom canvas pad below
        const AXIS_TITLE_TICK_GAP = 10;
        const AXIS_TITLE_BOTTOM_PAD = 8;
        const AXIS_TITLE_LEFT_GAP = 10;
        const extraBottom = (showAxisTitles && xAxisTitle)
            ? axisTitleFontSize + AXIS_TITLE_TICK_GAP + AXIS_TITLE_BOTTOM_PAD
            : 0;
        const extraLeft = (showAxisTitles && yAxisTitle)
            ? axisTitleFontSize + AXIS_TITLE_LEFT_GAP
            : 0;
        const allVals = bars.flatMap(b => [b.cumStart, b.cumEnd]);
        const yScale = d3Scale.scaleLinear()
            .domain([d3Array.min(allVals) ?? 0, d3Array.max(allVals) ?? 0]).nice();
        const tickWidth = Math.max(0, ...yScale.ticks(6).map(value =>
            this.textWidth(this.formatMeasure(value, displayUnits, decimalPlaces), axisLabelFontSize, axisLabelFontFamily, axisLabelWeight)));
        const effectiveMargin = {
            top: Math.max(this.margin.top, showValues ? fontSize + 10 : 12) + titleH,
            right: this.margin.right,
            bottom: (showAxisLabels ? axisLabelFontSize * 1.4 + 20 : 12) + extraBottom,
            left: 8 + extraLeft + (showAxisLabels ? tickWidth + 10 : 0)
        };

        const plotWidth = width - effectiveMargin.left - effectiveMargin.right;
        const plotHeight = height - effectiveMargin.top - effectiveMargin.bottom;
        if (plotWidth < 32 || plotHeight < 24) {
            this.renderCompact(width, height);
            return;
        }

        this.chartGroup.attr("transform", `translate(${effectiveMargin.left},${effectiveMargin.top})`);

        // Band positions key off each bar's IDENTITY, never its caption (NEXUS
        // cycle-14 §3). A display label is not unique: an ordinary category may
        // legitimately be called Forecast or Actual, both anchors may be named
        // Total, and two source rows may share a caption. Every one of those
        // collapsed onto a single band — rectangle, connector and label stacked
        // on one coordinate — because the domain was built from labels.
        const xScale = d3Scale.scaleBand<string>()
            .domain(bars.map(b => b.key))
            .range([0, plotWidth])
            .padding(1 - barWidthRatio);

        // AXIS STABILITY: the pad used to be 5% of the CURRENT range, so it grew
        // with the data and pushed .nice() across a rounding boundary mid-render
        // — every bar shifted at once, which reads as a jolt when the values
        // animate. .nice() already rounds the domain outward and supplies the
        // headroom the pad was there for, so the domain now only changes when the
        // data genuinely crosses a round boundary instead of drifting every frame.
        yScale.range([plotHeight, 0]);

        this.drawYAxis(yScale, plotHeight, plotWidth, axisLabelColor, axisLabelFontSize, gridlineColor, gridlineWidth, showGridlines, axisLineColor,
            axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
        this.drawXAxis(xScale, bars, plotHeight, bars.length, axisLabelColor, axisLabelFontSize, axisLineColor,
            axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
        if (!showAxisLabels) {
            this.chartGroup.selectAll(".y-tick,.x-label").remove();
        }

        // v2 (01-17): connectors are solid 1.5px hairlines at 55% opacity
        // (board .wconn) — the running level carried between columns.
        if (showConnectors) {
            for (let i = 0; i < bars.length - 1; i++) {
                const cur = bars[i], nxt = bars[i + 1];
                const cy = yScale(cur.cumEnd);
                this.chartGroup.append("line").classed("connector", true)
                    .attr("x1", (xScale(cur.key) ?? 0) + xScale.bandwidth())
                    .attr("y1", cy).attr("x2", xScale(nxt.key) ?? 0).attr("y2", cy)
                    .attr("stroke", connectorColor).attr("stroke-width", 1.5).attr("opacity", 0.55);
            }
        }

        const barGroup = this.chartGroup.selectAll(".wf-bar").data(bars).enter().append("g").classed("wf-bar", true);
        // #819 Neon: the flare rides the GROUP, so the column and the value
        // label sitting on it glow together (a live style — it covers the
        // rects and text appended below).
        barGroup.style("filter", d => this.barGroupGlow(this.resolveBarColor(d, positiveColor, negativeColor, totalColor)) || null);

        // v2 (01-17): columns render the beveled 3-stop gradient (mirrors
        // accentBarGradient) over the direction-law colour, glow on dark,
        // and settle once bottom-up (§6).
        const gradCache = new Map<string, string>();
        const quantised = this.formattingSettings.waterfallCard.quantisedMode.value;
        if (quantised) {
            this.drawQuantisedColumn(barGroup, "v",
                d => xScale(d.key) ?? 0,
                d => yScale(Math.max(d.cumStart, d.cumEnd)),
                () => xScale.bandwidth(),
                d => Math.abs(yScale(d.cumStart) - yScale(d.cumEnd)),
                d => this.resolveBarColor(d, positiveColor, negativeColor, totalColor));
        } else {
            barGroup.append("rect")
                .attr("x", d => xScale(d.key) ?? 0)
                .attr("y", d => yScale(Math.max(d.cumStart, d.cumEnd)))
                .attr("width", xScale.bandwidth())
                .attr("height", d => Math.abs(yScale(d.cumStart) - yScale(d.cumEnd)))
                .attr("fill", d => this.isHighContrast
                    ? this.colorPalette.foreground.value
                    : this.barFillFor(gradCache, this.resolveBarColor(d, positiveColor, negativeColor, totalColor)))
                .attr("rx", 3).attr("ry", 3)
                .style("filter", d => this.glowFor(this.resolveBarColor(d, positiveColor, negativeColor, totalColor)) || null)
                .each((d, i, nodes) => this.settleColumn(nodes[i] as SVGElement, "scaleY"));
        }

        // High contrast overrides for vertical bars and connectors
        if (this.isHighContrast) {
            const hcFg = this.colorPalette.foreground.value;
            barGroup.selectAll("rect").attr("fill", hcFg);
            this.chartGroup.selectAll(".connector").attr("stroke", hcFg);
        }

        if (showValues) {
            this.drawVerticalLabels(barGroup, xScale, yScale,
                positiveColor, negativeColor, totalColor,
                valuePosition, fontSize, displayUnits, decimalPlaces, customValueColor,
                valueFontFamily, valueWeight, valueStyle, valueDecoration);

            // High contrast overrides for value labels
            if (this.isHighContrast) {
                const hcFg = this.colorPalette.foreground.value;
                const hcBg = this.colorPalette.background.value;
                barGroup.select(".bar-label").attr("fill", (d: WaterfallBar) => {
                    const barTop = yScale(Math.max(d.cumStart, d.cumEnd));
                    const barBottom = yScale(Math.min(d.cumStart, d.cumEnd));
                    const pos = this.resolvePosition(valuePosition, barBottom - barTop, fontSize);
                    return pos === "inside" ? hcBg : hcFg;
                });
            }
            this.fitValueLabels(barGroup, Math.max(0, xScale.step() - 6), Number.POSITIVE_INFINITY);
            this.addLabelBackings(barGroup,
                d => this.resolvePosition(valuePosition, Math.abs(yScale(d.cumStart) - yScale(d.cumEnd)), fontSize) === "inside",
                d => this.resolveBarColor(d, positiveColor, negativeColor, totalColor));
        }

        // Axis titles (vertical mode: X = categories, Y = values)
        if (showAxisTitles) {
            const titleColor = this.isHighContrast ? this.colorPalette.foreground.value : axisLabelColor;
            if (xAxisTitle) {
                // The category row and title have separate measured allowances.
                const labelAllowance = showAxisLabels ? axisLabelFontSize * 1.4 + 12 : 0;
                const titleY = plotHeight + labelAllowance + AXIS_TITLE_TICK_GAP + axisTitleFontSize;
                this.chartGroup.append("text")
                    .classed("axis-title x-axis-title", true)
                    .attr("x", plotWidth / 2)
                    .attr("y", titleY)
                    .attr("text-anchor", "middle")
                    .attr("font-size", `${axisTitleFontSize}px`)
                    .attr("font-weight", "600")
                    .attr("fill", titleColor)
                    .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
                    .text(xAxisTitle);
            }
            if (yAxisTitle) {
                // Single transform string ensures translate applied BEFORE rotation
                // (d3 .attr() order is otherwise honoured but separate transform attrs
                // can lose the rotate when written sequentially in some pipelines).
                const titleX = -(effectiveMargin.left - 8 - axisTitleFontSize / 2);
                const titleY = plotHeight / 2;
                this.chartGroup.append("text")
                    .classed("axis-title y-axis-title", true)
                    .attr("transform", `translate(${titleX},${titleY}) rotate(-90)`)
                    .attr("text-anchor", "middle")
                    .attr("dominant-baseline", "middle")
                    .attr("font-size", `${axisTitleFontSize}px`)
                    .attr("font-weight", "600")
                    .attr("fill", titleColor)
                    .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
                    .text(yAxisTitle);
            }
        }
    }

    private renderHorizontal(
        bars: WaterfallBar[], width: number, height: number, barWidthRatio: number,
        positiveColor: string, negativeColor: string, totalColor: string,
        showConnectors: boolean, connectorColor: string,
        showValues: boolean, valuePosition: string, fontSize: number,
        displayUnits: string, decimalPlaces: number,
        customValueColor: string, showAxisLabels: boolean, axisLabelColor: string, axisLabelFontSize: number,
        gridlineColor: string, gridlineWidth: number, showGridlines: boolean, axisLineColor: string,
        showAxisTitles: boolean, xAxisTitle: string, yAxisTitle: string, titleH: number,
        valueFontFamily: string, valueWeight: string, valueStyle: string, valueDecoration: string,
        axisLabelFontFamily: string, axisLabelWeight: string, axisLabelStyle: string, axisLabelDecoration: string
    ): void {
        // Horizontal: categories on Y, values on X
        const axisTitleFontSize = axisLabelFontSize + 2;
        const AXIS_TITLE_TICK_GAP = 10;
        const AXIS_TITLE_BOTTOM_PAD = 8;
        const AXIS_TITLE_LEFT_GAP = 10;
        const extraBottom = (showAxisTitles && xAxisTitle)
            ? axisTitleFontSize + AXIS_TITLE_TICK_GAP + AXIS_TITLE_BOTTOM_PAD
            : 0;
        const extraLeft = (showAxisTitles && yAxisTitle)
            ? axisTitleFontSize + AXIS_TITLE_LEFT_GAP
            : 0;
        const allVals = bars.flatMap(b => [b.cumStart, b.cumEnd]);
        const xScale = d3Scale.scaleLinear()
            .domain([d3Array.min(allVals) ?? 0, d3Array.max(allVals) ?? 0]).nice();
        const categoryWidth = Math.min(width * 0.3, 2 + Math.max(0, ...bars.map(b =>
            this.textWidth(b.label, axisLabelFontSize, axisLabelFontFamily, axisLabelWeight))));
        const tickWidth = Math.max(0, ...xScale.ticks(6).map(value =>
            this.textWidth(this.formatMeasure(value, displayUnits, decimalPlaces), axisLabelFontSize, axisLabelFontFamily, axisLabelWeight)));
        // Outside value labels: reserve only the width a label actually pushes
        // past the plot, measured against the scale, not the widest label on
        // both sides unconditionally (Neil 2026-09-12: "the axis values
        // shouldn't have so much padding all around them" — a third of the
        // tile was an empty gutter between the categories and the bars).
        const labelW = (b: WaterfallBar) => this.textWidth(this.barLabel(b, displayUnits, decimalPlaces), fontSize, valueFontFamily, valueWeight);
        const baseLeft = 8 + extraLeft + (showAxisLabels ? categoryWidth + 8 : 0);
        const baseRight = Math.max(12, tickWidth / 2 + 8);
        let outsideSpace = 0, rightSpace = 0;
        if (showValues && valuePosition !== "inside") {
            for (let pass = 0; pass < 2; pass++) {
                const pw = width - baseLeft - outsideSpace - baseRight - rightSpace;
                if (pw < 32) break;
                const trial = xScale.copy().range([0, pw]);
                let over = 0, overR = 0;
                for (const b of bars) {
                    const lo = trial(Math.min(b.cumStart, b.cumEnd)), hi = trial(Math.max(b.cumStart, b.cumEnd));
                    if (this.resolvePosition(valuePosition, hi - lo, (labelW(b) + 8) / 1.5) === "inside") continue;
                    if (b.type === "negative") over = Math.max(over, labelW(b) + 4 - lo);
                    else overR = Math.max(overR, hi + 4 + labelW(b) - pw);
                }
                outsideSpace = Math.ceil(over); rightSpace = Math.ceil(overR);
            }
        }
        const hMargin = {
            top: 20 + titleH, right: baseRight + rightSpace,
            bottom: Math.max(24, axisLabelFontSize + 16) + extraBottom,
            left: baseLeft + outsideSpace
        };
        const plotWidth = width - hMargin.left - hMargin.right;
        const plotHeight = height - hMargin.top - hMargin.bottom;
        if (plotWidth < 32 || plotHeight < 24) {
            this.renderCompact(width, height);
            return;
        }

        this.chartGroup.attr("transform", `translate(${hMargin.left},${hMargin.top})`);

        // Y axis = categories (band scale), X axis = values (linear).
        // Keyed by bar identity, not caption — see renderVertical (cycle-14 §3).
        const yScale = d3Scale.scaleBand<string>()
            .domain(bars.map(b => b.key))
            .range([0, plotHeight])
            .padding(1 - barWidthRatio);

        // AXIS STABILITY — see the vertical branch above. The proportional pad
        // grew with the data and tipped .nice() onto a new round number partway
        // through an animated sweep (observed: ~450K -> 500K between frames,
        // shifting every bar at once). .nice() supplies the outward rounding on
        // its own, so the domain now holds until the data crosses a boundary.
        xScale.range([0, plotWidth]);
        const labelPosition = (d: WaterfallBar): string => this.resolvePosition(valuePosition,
            Math.abs(xScale(d.cumEnd) - xScale(d.cumStart)),
            (this.textWidth(this.barLabel(d, displayUnits, decimalPlaces), fontSize, valueFontFamily, valueWeight) + 8) / 1.5);

        // Draw X axis (value axis, bottom)
        const xTicks = xScale.ticks(Math.max(1, Math.min(6, Math.floor(plotWidth / (tickWidth + 12)))));
        if (showGridlines) {
            this.chartGroup.selectAll(".grid-line").data(xTicks).enter()
                .append("line").classed("grid-line", true)
                .attr("x1", d => xScale(d)).attr("y1", 0)
                .attr("x2", d => xScale(d)).attr("y2", plotHeight)
                .attr("stroke", gridlineColor).attr("stroke-width", gridlineWidth);
        }

        if (showAxisLabels) {
            this.chartGroup.selectAll(".x-tick").data(xTicks).enter()
                .append("text").classed("x-tick", true)
                .attr("x", d => xScale(d)).attr("y", plotHeight + 14)
                .attr("text-anchor", "middle").attr("font-size", `${axisLabelFontSize}px`)
                .attr("fill", axisLabelColor).attr("font-family", axisLabelFontFamily)
                .style("font-weight", axisLabelWeight)
                .style("font-style", axisLabelStyle)
                .style("text-decoration", axisLabelDecoration)
                .text(d => this.formatMeasure(d, displayUnits, decimalPlaces));
        }

        // X axis line
        this.chartGroup.append("line").classed("axis-line", true)
            .attr("x1", 0).attr("y1", plotHeight).attr("x2", plotWidth).attr("y2", plotHeight)
            .attr("stroke", axisLineColor).attr("stroke-width", 1);

        // Y axis category labels
        if (showAxisLabels) {
            this.chartGroup.selectAll(".y-label").data(bars).enter()
                .append("text").classed("y-label", true)
                .attr("x", -8 - outsideSpace).attr("y", d => (yScale(d.key) ?? 0) + yScale.bandwidth() / 2)
                .attr("text-anchor", "end").attr("dominant-baseline", "central")
                .attr("font-size", `${axisLabelFontSize}px`).attr("fill", axisLabelColor)
                .attr("font-family", axisLabelFontFamily)
                .style("font-weight", axisLabelWeight)
                .style("font-style", axisLabelStyle)
                .style("text-decoration", axisLabelDecoration)
                .text(d => d.label)
                .each((d, index, nodes) => {
                    const node = nodes[index];
                    const font = Math.min(axisLabelFontSize, (yScale.step() - 2) / 1.3);
                    if (font < 6) node.style.display = "none";
                    else node.setAttribute("font-size", `${font}px`);
                    this.fitText(node, categoryWidth);
                });
        }

        // Y axis line
        this.chartGroup.append("line").classed("axis-line", true)
            .attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", plotHeight)
            .attr("stroke", axisLineColor).attr("stroke-width", 1);

        // Connector lines (horizontal: vertical connectors between bars) —
        // v2 (01-17): solid 1.5px hairlines at 55% opacity (board .wconn).
        if (showConnectors) {
            for (let i = 0; i < bars.length - 1; i++) {
                const cur = bars[i], nxt = bars[i + 1];
                const cx = xScale(cur.cumEnd);
                this.chartGroup.append("line").classed("connector", true)
                    .attr("x1", cx).attr("y1", (yScale(cur.key) ?? 0) + yScale.bandwidth())
                    .attr("x2", cx).attr("y2", yScale(nxt.key) ?? 0)
                    .attr("stroke", connectorColor).attr("stroke-width", 1.5).attr("opacity", 0.55);
            }
        }

        // Bars (horizontal) — v2 (01-17): beveled direction-law gradient +
        // glow on dark + settle once (see renderVertical note).
        const barGroup = this.chartGroup.selectAll(".wf-bar").data(bars).enter().append("g").classed("wf-bar", true);
        // #819 Neon: same group-level flare as the vertical renderer.
        barGroup.style("filter", d => this.barGroupGlow(this.resolveBarColor(d, positiveColor, negativeColor, totalColor)) || null);

        const gradCache = new Map<string, string>();
        const quantisedH = this.formattingSettings.waterfallCard.quantisedMode.value;
        if (quantisedH) {
            this.drawQuantisedColumn(barGroup, "h",
                d => xScale(Math.min(d.cumStart, d.cumEnd)),
                d => yScale(d.key) ?? 0,
                d => Math.abs(xScale(d.cumEnd) - xScale(d.cumStart)),
                () => yScale.bandwidth(),
                d => this.resolveBarColor(d, positiveColor, negativeColor, totalColor));
        } else {
            barGroup.append("rect")
                .attr("x", d => xScale(Math.min(d.cumStart, d.cumEnd)))
                .attr("y", d => yScale(d.key) ?? 0)
                .attr("width", d => Math.abs(xScale(d.cumEnd) - xScale(d.cumStart)))
                .attr("height", yScale.bandwidth())
                .attr("fill", d => this.isHighContrast
                    ? this.colorPalette.foreground.value
                    : this.barFillFor(gradCache, this.resolveBarColor(d, positiveColor, negativeColor, totalColor)))
                .attr("rx", 3).attr("ry", 3)
                .style("filter", d => this.glowFor(this.resolveBarColor(d, positiveColor, negativeColor, totalColor)) || null)
                .each((d, i, nodes) => this.settleColumn(nodes[i] as SVGElement, "scaleX"));
        }

        // High contrast overrides for horizontal bars, connectors, axes, gridlines, and labels
        if (this.isHighContrast) {
            const hcFg = this.colorPalette.foreground.value;
            barGroup.selectAll("rect").attr("fill", hcFg);
            this.chartGroup.selectAll(".connector").attr("stroke", hcFg);
            this.chartGroup.selectAll(".grid-line").attr("stroke", hcFg).attr("opacity", 0.3);
            this.chartGroup.selectAll(".axis-line").attr("stroke", hcFg);
            this.chartGroup.selectAll(".x-tick").attr("fill", hcFg);
            this.chartGroup.selectAll(".y-label").attr("fill", hcFg);
        }

        // Value labels
        if (showValues) {
            barGroup.append("text").classed("bar-label", true)
                .attr("y", d => (yScale(d.key) ?? 0) + yScale.bandwidth() / 2)
                .attr("x", d => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = labelPosition(d);
                    if (pos === "inside") return barLeft + barW / 2;
                    if (d.type === "negative") return barLeft - 4;
                    return barRight + 4;
                })
                .attr("text-anchor", d => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = labelPosition(d);
                    if (pos === "inside") return "middle";
                    return d.type === "negative" ? "end" : "start";
                })
                .attr("dominant-baseline", "central")
                .attr("font-size", `${fontSize}px`)
                .style("font-weight", valueWeight)
                .style("font-style", valueStyle)
                .style("text-decoration", valueDecoration)
                // v2 (01-17): value labels in tabular numerals (board .wvlab).
                .style("font-feature-settings", TABULAR_NUMS)
                .attr("font-family", valueFontFamily)
                .attr("fill", d => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = labelPosition(d);
                    if (pos === "inside") {
                        const c = this.resolveBarColor(d, positiveColor, negativeColor, totalColor);
                        return contrastInk(c, "#000000", "#ffffff");
                    }
                    return this.resolveValueFontColor(d, customValueColor);
                })
                .text(d => this.barLabel(d, displayUnits, decimalPlaces));

            // High contrast overrides for horizontal value labels
            if (this.isHighContrast) {
                const hcFg = this.colorPalette.foreground.value;
                const hcBg = this.colorPalette.background.value;
                barGroup.select(".bar-label").attr("fill", (d: WaterfallBar) => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = labelPosition(d);
                    return pos === "inside" ? hcBg : hcFg;
                });
            }
            this.fitValueLabels(barGroup, Number.POSITIVE_INFINITY, Math.max(0, yScale.step() - 2));
            this.addLabelBackings(barGroup,
                d => labelPosition(d) === "inside",
                d => this.resolveBarColor(d, positiveColor, negativeColor, totalColor));
        }

        // Axis titles (horizontal mode: X = values, Y = categories)
        if (showAxisTitles) {
            const titleColor = this.isHighContrast ? this.colorPalette.foreground.value : axisLabelColor;
            if (xAxisTitle) {
                const titleY = plotHeight + axisLabelFontSize + AXIS_TITLE_TICK_GAP + axisTitleFontSize;
                this.chartGroup.append("text")
                    .classed("axis-title x-axis-title", true)
                    .attr("x", plotWidth / 2)
                    .attr("y", titleY)
                    .attr("text-anchor", "middle")
                    .attr("font-size", `${axisTitleFontSize}px`)
                    .attr("font-weight", "600")
                    .attr("fill", titleColor)
                    .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
                    .text(xAxisTitle);
            }
            if (yAxisTitle) {
                const titleX = -(hMargin.left - 8 - axisTitleFontSize / 2);
                const titleY = plotHeight / 2;
                this.chartGroup.append("text")
                    .classed("axis-title y-axis-title", true)
                    .attr("transform", `translate(${titleX},${titleY}) rotate(-90)`)
                    .attr("text-anchor", "middle")
                    .attr("dominant-baseline", "middle")
                    .attr("font-size", `${axisTitleFontSize}px`)
                    .attr("font-weight", "600")
                    .attr("fill", titleColor)
                    .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
                    .text(yAxisTitle);
            }
        }
    }

    private drawVerticalLabels(
        barGroup: d3Selection.Selection<SVGGElement, WaterfallBar, SVGGElement, unknown>,
        xScale: d3Scale.ScaleBand<string>,
        yScale: d3Scale.ScaleLinear<number, number>,
        positiveColor: string, negativeColor: string, totalColor: string,
        valuePosition: string, fontSize: number, displayUnits: string, decimalPlaces: number,
        customValueColor: string,
        valueFontFamily: string, valueWeight: string, valueStyle: string, valueDecoration: string
    ): void {
        barGroup.append("text")
            .classed("bar-label", true)
            .attr("x", d => (xScale(d.key) ?? 0) + xScale.bandwidth() / 2)
            .attr("y", d => {
                const barTop = yScale(Math.max(d.cumStart, d.cumEnd));
                const barBottom = yScale(Math.min(d.cumStart, d.cumEnd));
                const barHeight = barBottom - barTop;
                const pos = this.resolvePosition(valuePosition, barHeight, fontSize);
                if (pos === "inside") return barTop + barHeight / 2;
                if (d.type === "negative") return barBottom + fontSize + 2;
                return barTop - 4;
            })
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", d => {
                const barTop = yScale(Math.max(d.cumStart, d.cumEnd));
                const barBottom = yScale(Math.min(d.cumStart, d.cumEnd));
                const pos = this.resolvePosition(valuePosition, barBottom - barTop, fontSize);
                return pos === "inside" ? "central" : "auto";
            })
            .attr("font-size", `${fontSize}px`)
            .attr("fill", d => {
                const barTop = yScale(Math.max(d.cumStart, d.cumEnd));
                const barBottom = yScale(Math.min(d.cumStart, d.cumEnd));
                const pos = this.resolvePosition(valuePosition, barBottom - barTop, fontSize);
                if (pos === "inside") {
                    const c = this.resolveBarColor(d, positiveColor, negativeColor, totalColor);
                    return contrastInk(c, "#000000", "#ffffff");
                }
                return this.resolveValueFontColor(d, customValueColor);
            })
            .style("font-weight", valueWeight)
            .style("font-style", valueStyle)
            .style("text-decoration", valueDecoration)
            // v2 (01-17): value labels in tabular numerals (board .wvlab).
            .style("font-feature-settings", TABULAR_NUMS)
            .attr("font-family", valueFontFamily)
            .text(d => this.barLabel(d, displayUnits, decimalPlaces));
    }

    private barLabel(d: WaterfallBar, units: string, decimals: number): string {
        const glyph = this.hc.active && d.type !== "total"
            ? statusGlyph(d.type === "positive" ? "up" : "down") + " " : "";
        const prefix = d.type !== "total" && d.value > 0 ? "+" : "";
        return glyph + prefix + this.formatMeasure(d.value, units, decimals)
            + (d.key === "#end" && this.unusableCategoryCount ? " (partial)" : "");
    }

    /**
     * Label text for a measure value (NEXUS cycle-14 §6).
     *
     * The old path was `toFixed` plus hand-rolled K/M/B suffixes, which never
     * looked at the model at all: a measure formatted `0.0%` printed 0.5 instead
     * of 50%, `$#,##0.00` lost its currency symbol, and no label ever used the
     * host locale's separators. Those are the measure's SEMANTICS, and dropping
     * them turns a currency bridge into a bare number.
     *
     * Division of responsibility:
     *   - model format string -> units (currency symbol, percentage) + digits
     *     when the report has not said otherwise, via the shared formatter;
     *   - host locale          -> grouping and decimal separators;
     *   - Display Units        -> which magnitude the mantissa is printed at;
     *   - Decimal Places       -> precision, always. It is a shipped control
     *     whose default is 0, so the format's own fraction section must not
     *     silently re-precision an existing report.
     */
    private formatMeasure(value: number, units: string, decimals: number): string {
        // A null/non-finite reading is a gap, never a number (class 3).
        if (value === null || value === undefined || !isFinite(value)) return "—";
        // Even an unformatted measure must use the host's separators and the
        // explicit precision control, rather than falling back to toFixed().
        const format = this.modelFormat || "0";
        if (format.indexOf("%") >= 0) {
            // Power BI stores a percentage as its decimal fraction, so the ×100
            // is a unit conversion, not a display unit — a percentage is never
            // abbreviated on top of it. The model format's own sections are kept
            // (`0.00%;(0.00%)` must print "(10.00%)"), with Decimal Places written
            // into each — rebuilding a bare `0.00%` here discarded the negative
            // section (NEXUS re-review 2026-09-13 W1).
            return formatModelNumber(value, Visual.withDecimals(format, decimals), this.hostLocale);
        }
        const { divisor, suffix } = unitScale(value, units);
        const sectioned = Visual.withDecimals(format, decimals);
        // A multi-section format (`#,0.00;(#,0.00)`) owns its own negative
        // rendering — the shared formatter routes a negative to its section,
        // so accounting parentheses come out of it and no sign is added here
        // (astra 14 §6: this path printed "-100.00" for "(100.00)").
        if (value < 0 && numericSections(sectioned).length > 1) {
            return formatModelNumber(value / divisor, sectioned, this.hostLocale) + suffix;
        }
        // The sign leads the whole figure, including the currency symbol: the
        // shared formatter prefixes the symbol to whatever the locale printed,
        // which reads "$-10.00". Print the magnitude and carry the sign here.
        // The digit test keeps a value that rounds away to nothing from
        // acquiring a "-0" (same guard the sibling visuals use).
        const body = formatModelNumber(Math.abs(value) / divisor, sectioned, this.hostLocale) + suffix;
        return `${value < 0 && /[1-9]/.test(body) ? "-" : ""}${body}`;
    }

    /** The report's explicit Decimal Places written into the model format's own
     *  fraction section, so the format's currency and grouping tokens survive
     *  the precision override instead of being parsed out and rebuilt here.
     *  Applied to EVERY `;` section, else `#,0.00;(#,0.00)` at 0 decimals
     *  became `#,0;(#,0.00)` — the negative section kept its own precision. */
    private static withDecimals(format: string, decimals: number): string {
        const fraction = decimals > 0 ? "." + "0".repeat(decimals) : "";
        return numericSections(format)
            .map((s) => /\.[0#]+/.test(s) ? s.replace(/\.[0#]+/, fraction) : s.replace(/([0#])(?![\s\S]*[0#])/, `$1${fraction}`))
            .join(";");
    }

    /** Resolve "auto" position: inside if bar is tall enough, otherwise outside */
    private resolvePosition(position: string, barHeight: number, fontSize: number): string {
        if (barHeight <= 0) return "outside";
        if (position === "inside") return "inside";
        if (position === "outside") return "outside";
        // auto: inside if bar is at least 1.5x font height
        return barHeight >= fontSize * 1.5 ? "inside" : "outside";
    }

    /** Draw Y axis with gridlines */
    private drawYAxis(
        yScale: d3Scale.ScaleLinear<number, number>, plotHeight: number, plotWidth: number,
        axisLabelColor: string, axisLabelFontSize: number,
        gridlineColor: string, gridlineWidth: number, showGridlines: boolean, axisLineColor: string,
        axisLabelFontFamily: string, axisLabelWeight: string, axisLabelStyle: string, axisLabelDecoration: string
    ): void {
        const ticks = yScale.ticks(Math.max(1, Math.min(6, Math.floor(plotHeight / (axisLabelFontSize + 8)))));

        // Gridlines
        if (showGridlines) {
            this.chartGroup.selectAll(".grid-line")
                .data(ticks)
                .enter()
                .append("line")
                .classed("grid-line", true)
                .attr("x1", 0)
                .attr("y1", d => yScale(d))
                .attr("x2", plotWidth)
                .attr("y2", d => yScale(d))
                .attr("stroke", gridlineColor)
                .attr("stroke-width", gridlineWidth);
        }

        // Tick labels
        this.chartGroup.selectAll(".y-tick")
            .data(ticks)
            .enter()
            .append("text")
            .classed("y-tick", true)
            .attr("x", -8)
            .attr("y", d => yScale(d))
            .attr("text-anchor", "end")
            .attr("dominant-baseline", "central")
            .attr("font-size", `${axisLabelFontSize}px`)
            .attr("fill", axisLabelColor)
            .attr("font-family", axisLabelFontFamily)
            .style("font-weight", axisLabelWeight)
            .style("font-style", axisLabelStyle)
            .style("text-decoration", axisLabelDecoration)
            // drawYAxis doesn't receive the format settings; use the resolved cache (set in update)
            .text(d => this.formatMeasure(d, this.currentDisplayUnits, this.currentDecimalPlaces));

        // Axis line
        this.chartGroup.append("line").classed("axis-line", true)
            .attr("x1", 0).attr("y1", 0)
            .attr("x2", 0).attr("y2", plotHeight)
            .attr("stroke", axisLineColor)
            .attr("stroke-width", 1);

        // High contrast overrides for Y axis
        if (this.isHighContrast) {
            const hcFg = this.colorPalette.foreground.value;
            this.chartGroup.selectAll(".grid-line").attr("stroke", hcFg).attr("opacity", 0.3);
            this.chartGroup.selectAll(".y-tick").attr("fill", hcFg);
            this.chartGroup.selectAll(".axis-line").attr("stroke", hcFg);
        }
    }

    /** Draw X axis with category labels */
    private drawXAxis(
        xScale: d3Scale.ScaleBand<string>, bars: WaterfallBar[], plotHeight: number, barCount: number,
        axisLabelColor: string, axisLabelFontSize: number, axisLineColor: string,
        axisLabelFontFamily: string, axisLabelWeight: string, axisLabelStyle: string, axisLabelDecoration: string
    ): void {
        // Position by key and fit the caption to the available category pitch.

        // Axis line
        this.chartGroup.append("line").classed("axis-line", true)
            .attr("x1", 0).attr("y1", plotHeight)
            .attr("x2", xScale.range()[1]).attr("y2", plotHeight)
            .attr("stroke", axisLineColor)
            .attr("stroke-width", 1);

        // Labels
        this.chartGroup.selectAll(".x-label")
            .data(bars)
            .enter()
            .append("text")
            .classed("x-label", true)
            .attr("x", d => (xScale(d.key) ?? 0) + xScale.bandwidth() / 2)
            .attr("y", plotHeight + 12)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "hanging")
            .attr("font-size", `${axisLabelFontSize}px`)
            .attr("fill", axisLabelColor)
            .attr("font-family", axisLabelFontFamily)
            .style("font-weight", axisLabelWeight)
            .style("font-style", axisLabelStyle)
            .style("text-decoration", axisLabelDecoration)
            .text(d => d.label)
            .each((d, index, nodes) => this.fitText(nodes[index], Math.max(0, xScale.step() - 6)));

        // High contrast overrides for X axis
        if (this.isHighContrast) {
            const hcFg = this.colorPalette.foreground.value;
            this.chartGroup.selectAll(".x-label").attr("fill", hcFg);
            this.chartGroup.selectAll(".axis-line").attr("stroke", hcFg);
        }
    }

    /** Render empty state message */
    private renderEmpty(width: number, height: number, message?: string): void {
        // Muted card signature on the landing/empty state (§4).
        applyCardSignature(this.cornerSignature, this.formattingSettings?.cardSignature, {
            autoHex: "#8f8ab8", muted: true,
            flareHex: flareHexFor(this.codex),
            hcActive: this.isHighContrast, hcColor: this.colorPalette.foreground.value,
            glowMix: 0,
        });
        const emptyText = message
            || this.localizationManager.getDisplayName("Empty_Title")
            || "Add Category, Start Value, and Variance fields to build the waterfall.";
        const fillColor = this.isHighContrast ? this.colorPalette.foreground.value
            : mutedInk(this.surfaceInk, this.surfaceHex);

        const fontSize = Math.max(1, Math.min(14, height - 8,
            14 * Math.max(0, width - 16) / Math.max(1, this.textWidth(emptyText, 14, "Segoe UI, Tahoma, Geneva, Verdana, sans-serif"))));
        this.svg.append("text")
            .classed("empty-message", true)
            .attr("x", width / 2)
            .attr("y", height / 2)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", `${fontSize}px`)
            .attr("fill", fillColor)
            .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .text(emptyText);
    }

    public destroy(): void {
        if (this.destroyed) return;
        // Drop the in-flight licence check FIRST: its redraw callback replays
        // update() against a torn-down target otherwise (NEXUS lifecycle finding).
        this.licenseGate.dispose();
        this.destroyed = true;
        this.lastUpdateOptions = null;
        this.currentBars = [];
        this.categoricalCategories = undefined;
        this.positiveColorHelper = null;
        this.negativeColorHelper = null;
        this.valueFontColorHelper = null;
        this.removeListeners.forEach(remove => remove());
        this.removeListeners = [];
        this.target.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
        this.tooltipService.hide({ isTouchEvent: false, immediately: true });
        this.cornerSignature?.destroy();
        this.cornerSignature = null;
        this.svg.remove();
    }

    /**
     * Returns properties pane formatting model content hierarchies, properties and latest formatting values.
     */
    public getFormattingModel(): powerbi.visuals.FormattingModel {
        this.formattingSettings.codexTheme.reveal();
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }
}

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

import { dataViewWildcard } from "powerbi-visuals-utils-dataviewutils";
import { ColorHelper } from "powerbi-visuals-utils-colorutils";

import { VisualFormattingSettingsModel, textAlignFor } from "./settings";
import { formatValue, clamp, contrastText } from "./utils";
import { toRgba } from "./shared/colorHelpers";
import { Theme, directionColor, accentToken } from "./shared/bandEngine";
import { surfaceTokens, TABULAR_NUMS, mix } from "./shared/designTokens";
import { resolveBorder } from "./shared/borderSettings";
import { makeCornerBrackets, CardSignatureHandle } from "./shared/cardSignature";
import { applyCardSignature } from "./shared/cardSignatureSettings";
import { settle } from "./shared/motion";
import { applyHighContrast, statusGlyph, HighContrastResolved } from "./shared/highContrast";

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

/** Luminance-based theme pick — same 0.55 threshold convention as the
 *  pbiKpiCard v3 pilot: decides whether the resolved background reads as
 *  a "dark" or "light" surface so the v3 token set stays legible. */
function themeFor(hex: string): Theme {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(hex || "");
    if (!m) return "dark";
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.55 ? "light" : "dark";
}

/** Represents one bar in the waterfall */
interface WaterfallBar {
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
    private host: IVisualHost;
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
    private formattingSettings: VisualFormattingSettingsModel;
    private formattingSettingsService: FormattingSettingsService;

    // Current data for tooltip/selection lookups
    private currentBars: WaterfallBar[] = [];
    private currentDisplayUnits: string = "auto";
    private currentDecimalPlaces: number = 0;

    // fx (TRANS-04) state
    private categoricalCategories: powerbi.DataViewCategoryColumn | undefined;
    private positiveColorHelper: ColorHelper | null = null;
    // fx (TEXT-02) state — bar value/data label colour
    private valueFontColorHelper: ColorHelper | null = null;

    // ─── v2 board look (01-17) state ───────────────────────────
    // Theme + HC resolved once per update(); corner-bracket signature
    // created once (constructor) and re-tinted per render; data signature
    // gates the settle-once motion (§6 — columns settle ONCE, never loop).
    private theme: Theme = "dark";
    private hc: HighContrastResolved = applyHighContrast(null);
    private cornerSignature: CardSignatureHandle | null = null;
    private lastDataSignature: string | null = null;
    private shouldSettle: boolean = false;

    // Margins
    private readonly margin = { top: 24, right: 20, bottom: 60, left: 64 };

    constructor(options: VisualConstructorOptions) {
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
        this.target.addEventListener("contextmenu", (e: MouseEvent) => {
            this.selectionManager.showContextMenu(
                {},
                { x: e.clientX, y: e.clientY }
            );
            e.preventDefault();
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
        this.target.addEventListener("mousemove", (e: MouseEvent) => {
            const bar = this.findBarFromEvent(e);
            if (bar) {
                const items: VisualTooltipDataItem[] = [
                    { displayName: bar.label, value: formatValue(bar.value, this.currentDisplayUnits, this.currentDecimalPlaces) }
                ];
                if (bar.type !== "total") {
                    items.push({ displayName: "Running Total", value: formatValue(bar.cumEnd, this.currentDisplayUnits, this.currentDecimalPlaces) });
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
        this.target.addEventListener("mouseleave", () => {
            this.tooltipService.hide({ isTouchEvent: false, immediately: false });
        });

        // Cross-filtering on bar click
        this.target.addEventListener("click", (e: MouseEvent) => {
            const bar = this.findBarFromEvent(e);
            if (bar && bar.selectionId) {
                this.selectionManager.select(bar.selectionId, e.ctrlKey || e.metaKey);
                e.stopPropagation();
            }
        });
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
            const resolved = this.valueFontColorHelper.getColorForMeasure(instanceObjects, "valueFontColor");
            if (resolved && resolved.length > 0) return resolved;
        }
        if (customValueColor && customValueColor.length > 0) return customValueColor;
        // v2 (01-17): outside value labels ride the direction law (board
        // .wvlab) — lime/magenta for drivers, theme text for anchors —
        // replacing the old flat #333 auto colour. fx rules and a user-set
        // swatch (above) still win.
        if (d.type === "positive") return directionColor(1, this.theme);
        if (d.type === "negative") return directionColor(-1, this.theme);
        return surfaceTokens(this.theme).text;
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

    /** Glow filter for driver/anchor columns — dark theme only, never
     *  under HC (§8 drops all glow). Empty string = no filter. */
    private glowFor(base: string): string {
        return this.hc.active || this.theme === "light"
            ? ""
            : `drop-shadow(0 0 9px color-mix(in srgb, ${base} 50%, transparent))`;
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

    /** Find which WaterfallBar the mouse is over by checking SVG rect elements */
    private findBarFromEvent(e: MouseEvent): WaterfallBar | null {
        const target = e.target as SVGElement;
        if (!target || target.tagName !== "rect") return null;
        const parentG = target.parentElement;
        if (!parentG || !parentG.classList.contains("wf-bar")) return null;
        // Find index among wf-bar groups
        const allBars = this.chartGroup.selectAll<SVGGElement, WaterfallBar>(".wf-bar").nodes();
        const idx = allBars.indexOf(parentG as unknown as SVGGElement);
        if (idx >= 0 && idx < this.currentBars.length) {
            return this.currentBars[idx];
        }
        return null;
    }

    public update(options: VisualUpdateOptions) {
        this.eventService.renderingStarted(options);

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
        if (this.isHighContrast) {
            this.backgroundRect.attr("fill", "none");
        } else {
            const bgTransparencyPct = background.transparency.value ?? 100;
            this.backgroundRect.attr("fill", toRgba(bgHex, bgTransparencyPct));
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

        // ─── v2 board look (01-17): theme + the single HC rule ─────────
        // Theme keys off the resolved background hex (pbiKpiCard pilot
        // convention); HC resolution routed through the ONE shared fallback
        // rule instead of a per-visual reinvention.
        // Theme-source ladder (suite standard): visible own bg governs;
        // user-set hex governs even at full transparency; else the report
        // theme palette background (was: assume the bgHex, which defaulted
        // white → light theme even on dark report pages).
        const bgTransparencyForTheme = this.formattingSettings.background.transparency.value ?? 100;
        const bgHexIsUserSet = bgHex.toLowerCase() !== "#ffffff";
        const paletteBg = (this.colorPalette && (this.colorPalette as any).background && (this.colorPalette as any).background.value) || "#ffffff";
        const themeSourceHex = (bgTransparencyForTheme < 100 || bgHexIsUserSet) ? bgHex : paletteBg;
        this.theme = themeFor(themeSourceHex);
        this.hc = applyHighContrast(this.colorPalette, {
            fallbackColor: this.formattingSettings.waterfallCard.positiveColor.value.value,
        });

        // Corner-bracket signature — accent (cyan) tinted per the board;
        // glow only on the dark theme, never under HC.
        applyCardSignature(this.cornerSignature, this.formattingSettings.cardSignature, {
            autoHex: accentToken(this.theme),
            hcActive: this.hc.active,
            hcColor: this.hc.color,
            glowMix: this.hc.active || this.theme === "light" ? 0 : 50,
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
            // swaps to the dark text token on dark surfaces.
            const setTitle = titleFmt.titleColor.value.value;
            const adaptiveTitle = setTitle === "#1a1a2e" && this.theme === "dark"
                ? surfaceTokens("dark").text : setTitle;
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
        // a user-set Connector Color still resolves.
        const connectorColor = wf.connectorColor.value.value !== CONNECTOR_COLOR_DEFAULT
            ? wf.connectorColor.value.value
            : surfaceTokens(this.theme).muted;
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
        const setAxisLabel = ax.axisLabelColor.value.value;
        const axisLabelColor = setAxisLabel === "#5e5d5a" && this.theme === "dark"
            ? surfaceTokens("dark").muted : setAxisLabel;
        const axisLabelFontSize = clamp(ax.axisLabelFontSize.value || 10, 6, 30);
        const setGridline = ax.gridlineColor.value.value;
        const gridlineColor = setGridline === "#e8e2d3" && this.theme === "dark"
            ? surfaceTokens("dark").border : setGridline;
        const gridlineWidth = Math.max(0.1, ax.gridlineWidth.value);
        const showGridlines = ax.showGridlines.value;
        const setAxisLine = ax.axisLineColor.value.value;
        const axisLineColor = setAxisLine === "#b4b2a9" && this.theme === "dark"
            ? surfaceTokens("dark").muted : setAxisLine;
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
        const valueWeight = weightFor(lbl.bold.value, "600");
        const valueStyle = lbl.italic.value ? "italic" : "normal";
        const valueDecoration = lbl.underline.value ? "underline" : "none";

        const axisLabelFontFamily = ax.axisLabelFontFamily.value || "Segoe UI, Tahoma, Geneva, Verdana, sans-serif";
        const axisLabelWeight = weightFor(ax.axisLabelBold.value, "400");
        const axisLabelStyle = ax.axisLabelItalic.value ? "italic" : "normal";
        const axisLabelDecoration = ax.axisLabelUnderline.value ? "underline" : "none";

        // Build category-variance pairs
        const startValue: number = startValueCol
            ? (Number(startValueCol.values[0]) || 0)
            : 0;

        interface CatVar { cat: string; variance: number; catIndex: number; }
        let items: CatVar[] = [];
        for (let i = 0; i < categories.length; i++) {
            const v = Number(varianceCol.values[i]) || 0;
            if (v !== 0) {
                items.push({ cat: String(categories[i]), variance: v, catIndex: i });
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

        if (orientation === "horizontal") {
            this.renderHorizontal(bars, width, height, barWidthRatio,
                positiveColor, negativeColor, totalColor,
                showConnectors, connectorColor,
                showValues, valuePosition, fontSize, displayUnits, decimalPlaces,
                customValueColor, showAxisLabels, axisLabelColor, axisLabelFontSize,
                gridlineColor, gridlineWidth, showGridlines, axisLineColor,
                showAxisTitles, xAxisTitle, yAxisTitle, titleH,
                valueFontFamily, valueWeight, valueStyle, valueDecoration,
                axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
        } else {
            this.renderVertical(bars, width, height, barWidthRatio,
                positiveColor, negativeColor, totalColor,
                showConnectors, connectorColor,
                showValues, valuePosition, fontSize, displayUnits, decimalPlaces,
                customValueColor, showAxisLabels, axisLabelColor, axisLabelFontSize,
                gridlineColor, gridlineWidth, showGridlines, axisLineColor,
                showAxisTitles, xAxisTitle, yAxisTitle, titleH,
                valueFontFamily, valueWeight, valueStyle, valueDecoration,
                axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
        }

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
        const effectiveMargin = {
            top: this.margin.top + titleH,
            right: this.margin.right,
            bottom: this.margin.bottom + extraBottom,
            left: this.margin.left + extraLeft
        };

        const plotWidth = width - effectiveMargin.left - effectiveMargin.right;
        const plotHeight = height - effectiveMargin.top - effectiveMargin.bottom;
        if (plotWidth <= 0 || plotHeight <= 0) return;

        this.chartGroup.attr("transform", `translate(${effectiveMargin.left},${effectiveMargin.top})`);

        const xScale = d3Scale.scaleBand<string>()
            .domain(bars.map(b => b.label))
            .range([0, plotWidth])
            .padding(1 - barWidthRatio);

        const allVals = bars.flatMap(b => [b.cumStart, b.cumEnd]);
        let yMin = d3Array.min(allVals) ?? 0;
        let yMax = d3Array.max(allVals) ?? 0;
        const yPad = (yMax - yMin) * 0.05 || 1;
        yMin -= yPad; yMax += yPad;

        const yScale = d3Scale.scaleLinear().domain([yMin, yMax]).range([plotHeight, 0]).nice();

        if (showAxisLabels) {
            this.drawYAxis(yScale, plotHeight, plotWidth, axisLabelColor, axisLabelFontSize, gridlineColor, gridlineWidth, showGridlines, axisLineColor,
                axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
            this.drawXAxis(xScale, plotHeight, bars.length, axisLabelColor, axisLabelFontSize, axisLineColor,
                axisLabelFontFamily, axisLabelWeight, axisLabelStyle, axisLabelDecoration);
        }

        // v2 (01-17): connectors are solid 1.5px hairlines at 55% opacity
        // (board .wconn) — the running level carried between columns.
        if (showConnectors) {
            for (let i = 0; i < bars.length - 1; i++) {
                const cur = bars[i], nxt = bars[i + 1];
                const cy = yScale(cur.cumEnd);
                this.chartGroup.append("line").classed("connector", true)
                    .attr("x1", (xScale(cur.label) ?? 0) + xScale.bandwidth())
                    .attr("y1", cy).attr("x2", xScale(nxt.label) ?? 0).attr("y2", cy)
                    .attr("stroke", connectorColor).attr("stroke-width", 1.5).attr("opacity", 0.55);
            }
        }

        const barGroup = this.chartGroup.selectAll(".wf-bar").data(bars).enter().append("g").classed("wf-bar", true);

        // v2 (01-17): columns render the beveled 3-stop gradient (mirrors
        // accentBarGradient) over the direction-law colour, glow on dark,
        // and settle once bottom-up (§6).
        const gradCache = new Map<string, string>();
        barGroup.append("rect")
            .attr("x", d => xScale(d.label) ?? 0)
            .attr("y", d => yScale(Math.max(d.cumStart, d.cumEnd)))
            .attr("width", xScale.bandwidth())
            .attr("height", d => Math.abs(yScale(d.cumStart) - yScale(d.cumEnd)))
            .attr("fill", d => this.isHighContrast
                ? this.colorPalette.foreground.value
                : this.barFillFor(gradCache, this.resolveBarColor(d, positiveColor, negativeColor, totalColor)))
            .attr("rx", 3).attr("ry", 3)
            .style("filter", d => this.glowFor(this.resolveBarColor(d, positiveColor, negativeColor, totalColor)) || null)
            .each((d, i, nodes) => this.settleColumn(nodes[i] as SVGElement, "scaleY"));

        // High contrast overrides for vertical bars and connectors
        if (this.isHighContrast) {
            const hcFg = this.colorPalette.foreground.value;
            barGroup.select("rect").attr("fill", hcFg);
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
        }

        // Axis titles (vertical mode: X = categories, Y = values)
        if (showAxisTitles) {
            const titleColor = this.isHighContrast ? this.colorPalette.foreground.value : axisLabelColor;
            if (xAxisTitle) {
                // Position title baseline AXIS_TITLE_BOTTOM_PAD above canvas bottom edge,
                // with AXIS_TITLE_TICK_GAP between tick row and title.
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
                // Single transform string ensures translate applied BEFORE rotation
                // (d3 .attr() order is otherwise honoured but separate transform attrs
                // can lose the rotate when written sequentially in some pipelines).
                const titleX = -(extraLeft - AXIS_TITLE_LEFT_GAP / 2);
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
        const hMargin = { top: 20 + titleH, right: 30, bottom: 30 + extraBottom, left: 100 + extraLeft };
        const plotWidth = width - hMargin.left - hMargin.right;
        const plotHeight = height - hMargin.top - hMargin.bottom;
        if (plotWidth <= 0 || plotHeight <= 0) return;

        this.chartGroup.attr("transform", `translate(${hMargin.left},${hMargin.top})`);

        // Y axis = categories (band scale), X axis = values (linear)
        const yScale = d3Scale.scaleBand<string>()
            .domain(bars.map(b => b.label))
            .range([0, plotHeight])
            .padding(1 - barWidthRatio);

        const allVals = bars.flatMap(b => [b.cumStart, b.cumEnd]);
        let xMin = d3Array.min(allVals) ?? 0;
        let xMax = d3Array.max(allVals) ?? 0;
        const xPad = (xMax - xMin) * 0.05 || 1;
        xMin -= xPad; xMax += xPad;

        const xScale = d3Scale.scaleLinear().domain([xMin, xMax]).range([0, plotWidth]).nice();

        // Draw X axis (value axis, bottom)
        const xTicks = xScale.ticks(6);
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
                .text(d => formatValue(d, "auto", 0));
        }

        // X axis line
        this.chartGroup.append("line").classed("axis-line", true)
            .attr("x1", 0).attr("y1", plotHeight).attr("x2", plotWidth).attr("y2", plotHeight)
            .attr("stroke", axisLineColor).attr("stroke-width", 1);

        // Y axis category labels
        if (showAxisLabels) {
            const labels = yScale.domain();
            this.chartGroup.selectAll(".y-label").data(labels).enter()
                .append("text").classed("y-label", true)
                .attr("x", -8).attr("y", d => (yScale(d) ?? 0) + yScale.bandwidth() / 2)
                .attr("text-anchor", "end").attr("dominant-baseline", "central")
                .attr("font-size", `${axisLabelFontSize}px`).attr("fill", axisLabelColor)
                .attr("font-family", axisLabelFontFamily)
                .style("font-weight", axisLabelWeight)
                .style("font-style", axisLabelStyle)
                .style("text-decoration", axisLabelDecoration)
                .text(d => d.length > 14 ? d.substring(0, 12) + "..." : d);
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
                    .attr("x1", cx).attr("y1", (yScale(cur.label) ?? 0) + yScale.bandwidth())
                    .attr("x2", cx).attr("y2", yScale(nxt.label) ?? 0)
                    .attr("stroke", connectorColor).attr("stroke-width", 1.5).attr("opacity", 0.55);
            }
        }

        // Bars (horizontal) — v2 (01-17): beveled direction-law gradient +
        // glow on dark + settle once (see renderVertical note).
        const barGroup = this.chartGroup.selectAll(".wf-bar").data(bars).enter().append("g").classed("wf-bar", true);

        const gradCache = new Map<string, string>();
        barGroup.append("rect")
            .attr("x", d => xScale(Math.min(d.cumStart, d.cumEnd)))
            .attr("y", d => yScale(d.label) ?? 0)
            .attr("width", d => Math.abs(xScale(d.cumEnd) - xScale(d.cumStart)))
            .attr("height", yScale.bandwidth())
            .attr("fill", d => this.isHighContrast
                ? this.colorPalette.foreground.value
                : this.barFillFor(gradCache, this.resolveBarColor(d, positiveColor, negativeColor, totalColor)))
            .attr("rx", 3).attr("ry", 3)
            .style("filter", d => this.glowFor(this.resolveBarColor(d, positiveColor, negativeColor, totalColor)) || null)
            .each((d, i, nodes) => this.settleColumn(nodes[i] as SVGElement, "scaleX"));

        // High contrast overrides for horizontal bars, connectors, axes, gridlines, and labels
        if (this.isHighContrast) {
            const hcFg = this.colorPalette.foreground.value;
            barGroup.select("rect").attr("fill", hcFg);
            this.chartGroup.selectAll(".connector").attr("stroke", hcFg);
            this.chartGroup.selectAll(".grid-line").attr("stroke", hcFg).attr("opacity", 0.3);
            this.chartGroup.selectAll(".axis-line").attr("stroke", hcFg);
            this.chartGroup.selectAll(".x-tick").attr("fill", hcFg);
            this.chartGroup.selectAll(".y-label").attr("fill", hcFg);
        }

        // Value labels
        if (showValues) {
            barGroup.append("text").classed("bar-label", true)
                .attr("y", d => (yScale(d.label) ?? 0) + yScale.bandwidth() / 2)
                .attr("x", d => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = this.resolvePosition(valuePosition, barW, fontSize * 3);
                    if (pos === "inside") return barLeft + barW / 2;
                    if (d.type === "negative") return barLeft - 4;
                    return barRight + 4;
                })
                .attr("text-anchor", d => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = this.resolvePosition(valuePosition, barW, fontSize * 3);
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
                    const pos = this.resolvePosition(valuePosition, barW, fontSize * 3);
                    if (pos === "inside") {
                        const c = this.resolveBarColor(d, positiveColor, negativeColor, totalColor);
                        return contrastText(c);
                    }
                    return this.resolveValueFontColor(d, customValueColor);
                })
                .text(d => {
                    // v2 HC (§8): a direction reading is never colour-only —
                    // the up/down glyph rides along under high contrast.
                    const glyph = this.hc.active && d.type !== "total"
                        ? statusGlyph(d.type === "positive" ? "up" : "down") + " "
                        : "";
                    const prefix = d.type !== "total" && d.value > 0 ? "+" : "";
                    return glyph + prefix + formatValue(d.value, displayUnits, decimalPlaces);
                });

            // High contrast overrides for horizontal value labels
            if (this.isHighContrast) {
                const hcFg = this.colorPalette.foreground.value;
                const hcBg = this.colorPalette.background.value;
                barGroup.select(".bar-label").attr("fill", (d: WaterfallBar) => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = this.resolvePosition(valuePosition, barW, fontSize * 3);
                    return pos === "inside" ? hcBg : hcFg;
                });
            }
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
                const titleX = -(extraLeft - AXIS_TITLE_LEFT_GAP / 2);
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
            .attr("x", d => (xScale(d.label) ?? 0) + xScale.bandwidth() / 2)
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
                    return contrastText(c);
                }
                return this.resolveValueFontColor(d, customValueColor);
            })
            .style("font-weight", valueWeight)
            .style("font-style", valueStyle)
            .style("text-decoration", valueDecoration)
            // v2 (01-17): value labels in tabular numerals (board .wvlab).
            .style("font-feature-settings", TABULAR_NUMS)
            .attr("font-family", valueFontFamily)
            .text(d => {
                // v2 HC (§8): a direction reading is never colour-only —
                // the up/down glyph rides along under high contrast.
                const glyph = this.hc.active && d.type !== "total"
                    ? statusGlyph(d.type === "positive" ? "up" : "down") + " "
                    : "";
                const prefix = d.type !== "total" && d.value > 0 ? "+" : "";
                return glyph + prefix + formatValue(d.value, displayUnits, decimalPlaces);
            });
    }

    /** Resolve "auto" position: inside if bar is tall enough, otherwise outside */
    private resolvePosition(position: string, barHeight: number, fontSize: number): string {
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
        const ticks = yScale.ticks(6);

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
            .text(d => formatValue(d, "auto", 0));

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
        xScale: d3Scale.ScaleBand<string>, plotHeight: number, barCount: number,
        axisLabelColor: string, axisLabelFontSize: number, axisLineColor: string,
        axisLabelFontFamily: string, axisLabelWeight: string, axisLabelStyle: string, axisLabelDecoration: string
    ): void {
        const labels = xScale.domain();
        const rotate = barCount > 6;

        // Axis line
        this.chartGroup.append("line").classed("axis-line", true)
            .attr("x1", 0).attr("y1", plotHeight)
            .attr("x2", xScale.range()[1]).attr("y2", plotHeight)
            .attr("stroke", axisLineColor)
            .attr("stroke-width", 1);

        // Labels
        this.chartGroup.selectAll(".x-label")
            .data(labels)
            .enter()
            .append("text")
            .classed("x-label", true)
            .attr("x", d => (xScale(d) ?? 0) + xScale.bandwidth() / 2)
            .attr("y", plotHeight + 12)
            .attr("text-anchor", rotate ? "end" : "middle")
            .attr("dominant-baseline", "hanging")
            .attr("font-size", `${axisLabelFontSize}px`)
            .attr("fill", axisLabelColor)
            .attr("font-family", axisLabelFontFamily)
            .style("font-weight", axisLabelWeight)
            .style("font-style", axisLabelStyle)
            .style("text-decoration", axisLabelDecoration)
            .attr("transform", d => {
                if (!rotate) return "";
                const cx = (xScale(d) ?? 0) + xScale.bandwidth() / 2;
                return `rotate(-45, ${cx}, ${plotHeight + 12})`;
            })
            .text(d => d.length > 14 ? d.substring(0, 12) + "..." : d);

        // High contrast overrides for X axis
        if (this.isHighContrast) {
            const hcFg = this.colorPalette.foreground.value;
            this.chartGroup.selectAll(".x-label").attr("fill", hcFg);
            this.chartGroup.selectAll(".axis-line").attr("stroke", hcFg);
        }
    }

    /** Render empty state message */
    private renderEmpty(width: number, height: number): void {
        // Muted card signature on the landing/empty state (§4).
        applyCardSignature(this.cornerSignature, this.formattingSettings?.cardSignature, { autoHex: "#8f8ab8", muted: true });
        const emptyText = this.localizationManager.getDisplayName("Empty_Title")
            || "Add Category, Start Value, and Variance fields to build the waterfall.";
        const fillColor = this.isHighContrast ? this.colorPalette.foreground.value : "#5e5d5a";

        this.svg.append("text")
            .classed("empty-message", true)
            .attr("x", width / 2)
            .attr("y", height / 2)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "14px")
            .attr("fill", fillColor)
            .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .text(emptyText);
    }

    public destroy(): void {
        this.cornerSignature?.destroy();
        this.cornerSignature = null;
        this.chartGroup.selectAll("*").remove();
    }

    /**
     * Returns properties pane formatting model content hierarchies, properties and latest formatting values.
     */
    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }
}

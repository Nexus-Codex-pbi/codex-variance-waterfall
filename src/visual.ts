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
import DataView = powerbi.DataView;
import DataViewCategorical = powerbi.DataViewCategorical;

import { VisualFormattingSettingsModel } from "./settings";
import { formatValue, clamp, contrastText } from "./utils";

type Selection<T extends d3Selection.BaseType> = d3Selection.Selection<T, unknown, null, undefined>;

/** Represents one bar in the waterfall */
interface WaterfallBar {
    label: string;
    value: number;      // the variance amount (or total for start/end)
    cumStart: number;    // y-position bottom of bar
    cumEnd: number;      // y-position top of bar
    type: "total" | "positive" | "negative";
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
    private chartGroup: Selection<SVGGElement>;
    private formattingSettings: VisualFormattingSettingsModel;
    private formattingSettingsService: FormattingSettingsService;

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

        this.chartGroup = this.svg.append("g").classed("chart-area", true);
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

        const positiveColor = wf.positiveColor.value.value;
        const negativeColor = wf.negativeColor.value.value;
        const totalColor = wf.totalColor.value.value;
        const showConnectors = wf.connectorLine.value;
        const connectorColor = wf.connectorColor.value.value;
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
        const axisLabelColor = ax.axisLabelColor.value.value;
        const axisLabelFontSize = clamp(ax.axisLabelFontSize.value || 10, 6, 30);
        const gridlineColor = ax.gridlineColor.value.value;
        const gridlineWidth = Math.max(0.1, ax.gridlineWidth.value);
        const showGridlines = ax.showGridlines.value;
        const axisLineColor = ax.axisLineColor.value.value;

        // Build category-variance pairs
        const startValue: number = startValueCol
            ? (Number(startValueCol.values[0]) || 0)
            : 0;

        interface CatVar { cat: string; variance: number; }
        let items: CatVar[] = [];
        for (let i = 0; i < categories.length; i++) {
            const v = Number(varianceCol.values[i]) || 0;
            if (v !== 0) {
                items.push({ cat: String(categories[i]), variance: v });
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
            visible.push({ cat: "Other", variance: otherSum });
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
            type: "total"
        });

        // Variance bars
        let running = startValue;
        for (const item of items) {
            const prev = running;
            running += item.variance;
            bars.push({
                label: item.cat,
                value: item.variance,
                cumStart: prev,
                cumEnd: running,
                type: item.variance >= 0 ? "positive" : "negative"
            });
        }

        // End total bar
        if (showEndTotal) {
            bars.push({
                label: endLabel,
                value: running,
                cumStart: 0,
                cumEnd: running,
                type: "total"
            });
        }

        const orientation = String(wf.orientation.value?.value || "vertical");

        if (orientation === "horizontal") {
            this.renderHorizontal(bars, width, height, barWidthRatio,
                positiveColor, negativeColor, totalColor,
                showConnectors, connectorColor,
                showValues, valuePosition, fontSize, displayUnits, decimalPlaces,
                customValueColor, axisLabelColor, axisLabelFontSize,
                gridlineColor, gridlineWidth, showGridlines, axisLineColor);
        } else {
            this.renderVertical(bars, width, height, barWidthRatio,
                positiveColor, negativeColor, totalColor,
                showConnectors, connectorColor,
                showValues, valuePosition, fontSize, displayUnits, decimalPlaces,
                customValueColor, axisLabelColor, axisLabelFontSize,
                gridlineColor, gridlineWidth, showGridlines, axisLineColor);
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
        customValueColor: string, axisLabelColor: string, axisLabelFontSize: number,
        gridlineColor: string, gridlineWidth: number, showGridlines: boolean, axisLineColor: string
    ): void {
        const plotWidth = width - this.margin.left - this.margin.right;
        const plotHeight = height - this.margin.top - this.margin.bottom;
        if (plotWidth <= 0 || plotHeight <= 0) return;

        this.chartGroup.attr("transform", `translate(${this.margin.left},${this.margin.top})`);

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

        this.drawYAxis(yScale, plotHeight, plotWidth, axisLabelColor, axisLabelFontSize, gridlineColor, gridlineWidth, showGridlines, axisLineColor);
        this.drawXAxis(xScale, plotHeight, bars.length, axisLabelColor, axisLabelFontSize, axisLineColor);

        if (showConnectors) {
            for (let i = 0; i < bars.length - 1; i++) {
                const cur = bars[i], nxt = bars[i + 1];
                const cy = yScale(cur.cumEnd);
                this.chartGroup.append("line").classed("connector", true)
                    .attr("x1", (xScale(cur.label) ?? 0) + xScale.bandwidth())
                    .attr("y1", cy).attr("x2", xScale(nxt.label) ?? 0).attr("y2", cy)
                    .attr("stroke", connectorColor).attr("stroke-width", 1).attr("stroke-dasharray", "4,3");
            }
        }

        const barGroup = this.chartGroup.selectAll(".wf-bar").data(bars).enter().append("g").classed("wf-bar", true);

        barGroup.append("rect")
            .attr("x", d => xScale(d.label) ?? 0)
            .attr("y", d => yScale(Math.max(d.cumStart, d.cumEnd)))
            .attr("width", xScale.bandwidth())
            .attr("height", d => Math.abs(yScale(d.cumStart) - yScale(d.cumEnd)))
            .attr("fill", d => d.type === "total" ? totalColor : d.type === "positive" ? positiveColor : negativeColor)
            .attr("rx", 2).attr("ry", 2);

        if (showValues) {
            this.drawVerticalLabels(barGroup, xScale, yScale,
                positiveColor, negativeColor, totalColor,
                valuePosition, fontSize, displayUnits, decimalPlaces, customValueColor);
        }
    }

    private renderHorizontal(
        bars: WaterfallBar[], width: number, height: number, barWidthRatio: number,
        positiveColor: string, negativeColor: string, totalColor: string,
        showConnectors: boolean, connectorColor: string,
        showValues: boolean, valuePosition: string, fontSize: number,
        displayUnits: string, decimalPlaces: number,
        customValueColor: string, axisLabelColor: string, axisLabelFontSize: number,
        gridlineColor: string, gridlineWidth: number, showGridlines: boolean, axisLineColor: string
    ): void {
        // Horizontal: categories on Y, values on X
        const hMargin = { top: 20, right: 30, bottom: 30, left: 100 };
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

        this.chartGroup.selectAll(".x-tick").data(xTicks).enter()
            .append("text").classed("x-tick", true)
            .attr("x", d => xScale(d)).attr("y", plotHeight + 14)
            .attr("text-anchor", "middle").attr("font-size", `${axisLabelFontSize}px`)
            .attr("fill", axisLabelColor).attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .text(d => formatValue(d, "auto", 0));

        // X axis line
        this.chartGroup.append("line")
            .attr("x1", 0).attr("y1", plotHeight).attr("x2", plotWidth).attr("y2", plotHeight)
            .attr("stroke", axisLineColor).attr("stroke-width", 1);

        // Y axis category labels
        const labels = yScale.domain();
        this.chartGroup.selectAll(".y-label").data(labels).enter()
            .append("text").classed("y-label", true)
            .attr("x", -8).attr("y", d => (yScale(d) ?? 0) + yScale.bandwidth() / 2)
            .attr("text-anchor", "end").attr("dominant-baseline", "central")
            .attr("font-size", `${axisLabelFontSize}px`).attr("fill", axisLabelColor)
            .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .text(d => d.length > 14 ? d.substring(0, 12) + "..." : d);

        // Y axis line
        this.chartGroup.append("line")
            .attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", plotHeight)
            .attr("stroke", axisLineColor).attr("stroke-width", 1);

        // Connector lines (horizontal: vertical connectors between bars)
        if (showConnectors) {
            for (let i = 0; i < bars.length - 1; i++) {
                const cur = bars[i], nxt = bars[i + 1];
                const cx = xScale(cur.cumEnd);
                this.chartGroup.append("line").classed("connector", true)
                    .attr("x1", cx).attr("y1", (yScale(cur.label) ?? 0) + yScale.bandwidth())
                    .attr("x2", cx).attr("y2", yScale(nxt.label) ?? 0)
                    .attr("stroke", connectorColor).attr("stroke-width", 1).attr("stroke-dasharray", "4,3");
            }
        }

        // Bars (horizontal)
        const barGroup = this.chartGroup.selectAll(".wf-bar").data(bars).enter().append("g").classed("wf-bar", true);

        barGroup.append("rect")
            .attr("x", d => xScale(Math.min(d.cumStart, d.cumEnd)))
            .attr("y", d => yScale(d.label) ?? 0)
            .attr("width", d => Math.abs(xScale(d.cumEnd) - xScale(d.cumStart)))
            .attr("height", yScale.bandwidth())
            .attr("fill", d => d.type === "total" ? totalColor : d.type === "positive" ? positiveColor : negativeColor)
            .attr("rx", 2).attr("ry", 2);

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
                .attr("font-weight", "600")
                .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
                .attr("fill", d => {
                    const barLeft = xScale(Math.min(d.cumStart, d.cumEnd));
                    const barRight = xScale(Math.max(d.cumStart, d.cumEnd));
                    const barW = barRight - barLeft;
                    const pos = this.resolvePosition(valuePosition, barW, fontSize * 3);
                    if (pos === "inside") {
                        const c = d.type === "total" ? totalColor : d.type === "positive" ? positiveColor : negativeColor;
                        return contrastText(c);
                    }
                    return customValueColor && customValueColor.length > 0 ? customValueColor : "#333";
                })
                .text(d => {
                    const prefix = d.type !== "total" && d.value > 0 ? "+" : "";
                    return prefix + formatValue(d.value, displayUnits, decimalPlaces);
                });
        }
    }

    private drawVerticalLabels(
        barGroup: d3Selection.Selection<SVGGElement, WaterfallBar, SVGGElement, unknown>,
        xScale: d3Scale.ScaleBand<string>,
        yScale: d3Scale.ScaleLinear<number, number>,
        positiveColor: string, negativeColor: string, totalColor: string,
        valuePosition: string, fontSize: number, displayUnits: string, decimalPlaces: number,
        customValueColor: string
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
                    const c = d.type === "total" ? totalColor : d.type === "positive" ? positiveColor : negativeColor;
                    return contrastText(c);
                }
                return customValueColor && customValueColor.length > 0 ? customValueColor : "#333";
            })
            .attr("font-weight", "600")
            .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .text(d => {
                const prefix = d.type !== "total" && d.value > 0 ? "+" : "";
                return prefix + formatValue(d.value, displayUnits, decimalPlaces);
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
        gridlineColor: string, gridlineWidth: number, showGridlines: boolean, axisLineColor: string
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
            .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .text(d => formatValue(d, "auto", 0));

        // Axis line
        this.chartGroup.append("line")
            .attr("x1", 0).attr("y1", 0)
            .attr("x2", 0).attr("y2", plotHeight)
            .attr("stroke", axisLineColor)
            .attr("stroke-width", 1);
    }

    /** Draw X axis with category labels */
    private drawXAxis(
        xScale: d3Scale.ScaleBand<string>, plotHeight: number, barCount: number,
        axisLabelColor: string, axisLabelFontSize: number, axisLineColor: string
    ): void {
        const labels = xScale.domain();
        const rotate = barCount > 6;

        // Axis line
        this.chartGroup.append("line")
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
            .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .attr("transform", d => {
                if (!rotate) return "";
                const cx = (xScale(d) ?? 0) + xScale.bandwidth() / 2;
                return `rotate(-45, ${cx}, ${plotHeight + 12})`;
            })
            .text(d => d.length > 14 ? d.substring(0, 12) + "..." : d);
    }

    /** Render empty state message */
    private renderEmpty(width: number, height: number): void {
        this.svg.append("text")
            .classed("empty-message", true)
            .attr("x", width / 2)
            .attr("y", height / 2)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "14px")
            .attr("fill", "#5e5d5a")
            .attr("font-family", "Segoe UI, Tahoma, Geneva, Verdana, sans-serif")
            .text("Add Category, Start Value, and Variance fields to build the waterfall.");
    }

    public destroy(): void {
        this.chartGroup.selectAll("*").remove();
    }

    /**
     * Returns properties pane formatting model content hierarchies, properties and latest formatting values.
     */
    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }
}

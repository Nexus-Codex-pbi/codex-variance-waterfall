"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

/**
 * Waterfall Appearance Card
 */
class WaterfallSettingsCard extends FormattingSettingsCard {
    positiveColor = new formattingSettings.ColorPicker({
        name: "positiveColor",
        displayName: "Positive Color",
        description: "Color for positive variance bars",
        value: { value: "#007064" }
    });

    negativeColor = new formattingSettings.ColorPicker({
        name: "negativeColor",
        displayName: "Negative Color",
        description: "Color for negative variance bars",
        value: { value: "#e60e22" }
    });

    totalColor = new formattingSettings.ColorPicker({
        name: "totalColor",
        displayName: "Total Color",
        description: "Color for start and end total bars",
        value: { value: "#130064" }
    });

    connectorLine = new formattingSettings.ToggleSwitch({
        name: "connectorLine",
        displayName: "Connector Lines",
        description: "Show dashed connector lines between bars",
        value: true
    });

    connectorColor = new formattingSettings.ColorPicker({
        name: "connectorColor",
        displayName: "Connector Color",
        description: "Color of connector lines",
        value: { value: "#b4b2a9" }
    });

    showEndTotal = new formattingSettings.ToggleSwitch({
        name: "showEndTotal",
        displayName: "Show End Total",
        description: "Show the final actual total bar",
        value: true
    });

    startLabel = new formattingSettings.TextInput({
        name: "startLabel",
        displayName: "Start Label",
        description: "Label for the opening total bar",
        placeholder: "Forecast",
        value: "Forecast"
    });

    endLabel = new formattingSettings.TextInput({
        name: "endLabel",
        displayName: "End Label",
        description: "Label for the closing total bar",
        placeholder: "Actual",
        value: "Actual"
    });

    barWidth = new formattingSettings.NumUpDown({
        name: "barWidth",
        displayName: "Bar Width Ratio",
        description: "Bar width as ratio of band (0.1 to 1.0)",
        value: 0.6
    });

    orientation = new formattingSettings.ItemDropdown({
        name: "orientation",
        displayName: "Orientation",
        description: "Chart direction: vertical bars or horizontal bars",
        items: [
            { displayName: "Vertical", value: "vertical" },
            { displayName: "Horizontal", value: "horizontal" }
        ],
        value: { displayName: "Vertical", value: "vertical" }
    });

    name: string = "waterfallSettings";
    displayName: string = "Waterfall";
    slices: Array<FormattingSettingsSlice> = [
        this.orientation,
        this.positiveColor,
        this.negativeColor,
        this.totalColor,
        this.connectorLine,
        this.connectorColor,
        this.showEndTotal,
        this.startLabel,
        this.endLabel,
        this.barWidth
    ];
}

/**
 * Sort & Grouping Card
 */
class SortSettingsCard extends FormattingSettingsCard {
    sortBy = new formattingSettings.ItemDropdown({
        name: "sortBy",
        displayName: "Sort By",
        description: "How to order variance categories",
        items: [
            { displayName: "Variance (High to Low)", value: "variance_desc" },
            { displayName: "Variance (Low to High)", value: "variance_asc" },
            { displayName: "Category (A-Z)", value: "category" },
            { displayName: "Absolute (High to Low)", value: "absolute_desc" }
        ],
        value: { displayName: "Variance (High to Low)", value: "variance_desc" }
    });

    maxCategories = new formattingSettings.NumUpDown({
        name: "maxCategories",
        displayName: "Max Categories",
        description: "Maximum number of categories to display (remainder grouped as Other)",
        value: 10
    });

    name: string = "sortSettings";
    displayName: string = "Sort & Grouping";
    slices: Array<FormattingSettingsSlice> = [this.sortBy, this.maxCategories];
}

/**
 * Label Formatting Card
 */
class LabelSettingsCard extends FormattingSettingsCard {
    showValues = new formattingSettings.ToggleSwitch({
        name: "showValues",
        displayName: "Show Values",
        description: "Display value labels on bars",
        value: true
    });

    valuePosition = new formattingSettings.ItemDropdown({
        name: "valuePosition",
        displayName: "Value Position",
        description: "Where to place value labels",
        items: [
            { displayName: "Inside", value: "inside" },
            { displayName: "Outside", value: "outside" },
            { displayName: "Auto", value: "auto" }
        ],
        value: { displayName: "Auto", value: "auto" }
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Font Size",
        description: "Label font size in points",
        value: 11
    });

    displayUnits = new formattingSettings.ItemDropdown({
        name: "displayUnits",
        displayName: "Display Units",
        description: "How to format numeric labels",
        items: [
            { displayName: "Auto", value: "auto" },
            { displayName: "None", value: "none" },
            { displayName: "Thousands", value: "thousands" },
            { displayName: "Millions", value: "millions" }
        ],
        value: { displayName: "Auto", value: "auto" }
    });

    decimalPlaces = new formattingSettings.NumUpDown({
        name: "decimalPlaces",
        displayName: "Decimal Places",
        description: "Number of decimal places for labels",
        value: 0
    });

    name: string = "labelSettings";
    displayName: string = "Data Labels";
    slices: Array<FormattingSettingsSlice> = [
        this.showValues,
        this.valuePosition,
        this.fontSize,
        this.displayUnits,
        this.decimalPlaces
    ];
}

/**
 * Visual Formatting Settings Model
 */
export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    waterfallCard = new WaterfallSettingsCard();
    sortCard = new SortSettingsCard();
    labelCard = new LabelSettingsCard();

    cards = [this.waterfallCard, this.sortCard, this.labelCard];
}

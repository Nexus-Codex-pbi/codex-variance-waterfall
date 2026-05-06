# User Guide – Codex Variance Waterfall

## Overview
Variance waterfall showing forecast-to-actual decomposition with cumulative running totals.

## 1. Adding the Visual
1. Import the `.pbiviz` file into Power BI Desktop
2. Locate the visual in the Visualizations pane
3. Drag it onto the report canvas

## 2. Data Binding
- Category: Breakdown dimension (e.g. BatteryCode or Beat)
- Start Value: Opening total (e.g. forecast qty)
- Variance: Per-category variance amount

## 3. Formatting Options
- Waterfall Settings: Positive Color, Negative Color, Total Color, Connector Line, Connector Color, Show End Total, Start Label, End Label, Bar Width, Orientation (Vertical/Horizontal)
- Sort Settings: Sort By (Variance High to Low, Variance Low to High, Category A-Z, Absolute High to Low), Max Categories
- Label Settings: Show Values, Value Position (Inside/Outside/Auto), Font Size, Display Units (Auto/None/Thousands/Millions), Decimal Places, Value Font Color
- Axis Settings: Show Axis Labels, Axis Label Color, Axis Label Font Size, Gridline Color, Gridline Width, Show Gridlines, Axis Line Color, Show Axis Titles, X Axis Title, Y Axis Title

## 4. Features
- Forecast-to-actual variance decomposition with running totals
- Horizontal or vertical orientation options
- Conditional coloring for positive/negative variances
- Interactive tooltips and cross-filtering
- Configurable sorting and category limits (with overflow to "Other")
- High contrast mode support

## 5. Limitations
- Single category breakdown (only one grouping field supported)
- Variance values are summed per category (multiple rows per category are aggregated)
- Start Value must be a single value (first row used if multiple)
- Maximum 30,000 categories due to data reduction algorithm
- Requires at least one category and both start and variance values to render

## 6. Support
For help or questions, visit https://nexuscodex.nexus/support
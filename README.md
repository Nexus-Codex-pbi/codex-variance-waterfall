# Codex Variance Waterfall

## Overview
Variance waterfall showing forecast-to-actual decomposition with cumulative running totals.

## Features
- Displays a starting value, intermediate variance bars, and an ending total
- Shows how individual category variances contribute to the change from start to end
- Supports vertical and horizontal orientation
- Configurable colors for positive, negative, and total bars
- Optional connector lines between bars
- Customizable start and end labels (e.g., "Forecast" and "Actual")
- Sorting options: by variance (high to low, low to high), by category (A-Z), or by absolute variance (high to low)
- Limit the number of categories displayed (remaining grouped into "Other")
- Value labels can be shown inside, outside, or automatically positioned
- Full control over value formatting: display units, decimal places, font size, and color
- Axis labels, gridlines, and axis titles configurable
- Tooltips showing label, value, and running total
- Click to cross-filter other visuals by category
- Right-click context menu for cross-filtering and other interactions
- High contrast mode support
- Supports keyboard focus and screen readers

## Data Roles
| Role | Display Name | Kind | Required? | Data Type | Description |
|------|--------------|------|-----------|-----------|-------------|
| category | Category | Grouping | No (max 1) | Text or Grouping | Breakdown dimension (e.g. BatteryCode or Beat) |
| startValue | Start Value | Measure | No (max 1) | Numeric | Opening total (e.g. forecast qty) |
| variance | Variance | Measure | No (max 1) | Numeric | Per-category variance amount |

Note: Each role can have at most one field bound. At least the Variance role is required for meaningful display. If Start Value is not bound, it defaults to zero.

## Formatting Options
The visual provides the following format pane cards:

### Waterfall Settings
- Positive Color: Fill color for positive variance bars
- Negative Color: Fill color for negative variance bars
- Total Color: Fill color for the start and total bars
- Connector Line: Toggle visibility of lines connecting the bars
- Connector Color: Color of the connector lines
- Show End Total: Toggle visibility of the ending total bar
- Start Label: Label for the starting bar (default: "Forecast")
- End Label: Label for the ending bar (default: "Actual")
- Bar Width: Relative width of the bars (0.1 to 1.0)
- Orientation: Vertical or Horizontal

### Sort Settings
- Sort By: Variance (High to Low), Variance (Low to High), Category (A-Z), Absolute (High to Low)
- Max Categories: Maximum number of individual category bars to display (remaining grouped into "Other")

### Label Settings
- Show Values: Toggle visibility of value labels on bars
- Value Position: Inside, Outside, or Auto (automatic positioning based on bar size)
- Font Size: Font size for value labels in pixels
- Display Units: Auto, None, Thousands, Millions (for value labels)
- Decimal Places: Number of decimal places to display (0-6)
- Value Font Color: Text color for value labels

### Axis Settings
- Show Axis Labels: Toggle visibility of axis tick labels
- Axis Label Color: Text color of axis labels
- Axis Label Font Size: Font size of axis labels in pixels
- Gridline Color: Color of axis gridlines
- Gridline Width: Width of axis gridlines in pixels
- Show Gridlines: Toggle visibility of axis gridlines
- Axis Line Color: Color of the axis line
- Show Axis Titles: Toggle visibility of axis titles
- X Axis Title: Title for the X-axis
- Y Axis Title: Title for the Y-axis

## How to Use
1. Import the `.pbiviz` file into Power BI Desktop (from the Visuals pane -> ... -> Import from file).
2. Locate the visual in the Visualizations pane and add it to the report canvas.
3. Bind data to the data roles:
   - Category: Field for breakdown (e.g., Product, Region)
   - Start Value: Optional numeric measure for the opening total (if omitted, defaults to 0)
   - Variance: Required numeric measure for the per-category variance
4. Use the format pane to adjust appearance:
   - Set colors, connector lines, labels, and orientation
   - Choose sort order and limit categories
   - Configure value labels and axis properties
5. Interact:
   - Click a bar to cross-filter other visuals by that category
   - Right-click for the context menu
   - Hover to see a tooltip with the bar label, value, and running total

## Limitations
- The visual expects numeric values for Start Value and Variance. Non-numeric values are treated as zero.
- Each data role accepts only one field.
- The visual uses a data reduction algorithm (top 30,000 rows) which may limit the number of categories displayed.
- When Show End Total is disabled, the ending total is not shown (the waterfall ends at the last variance bar).
- The visual does not support drill-through or bookmark selection.
- In horizontal orientation, the axis is vertical (Y-axis) and labels are on the X-axis.

## Support
For help or questions, visit https://nexuscodex.nexus/support
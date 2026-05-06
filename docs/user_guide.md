# User Guide for Codex Variance Waterfall

## Adding the Visual
1. Open Power BI Desktop or Power BI Service
2. Navigate to the Visualizations pane
3. Select the Codex Variance Waterfall visual from the visual gallery
4. Drag and drop the visual onto your report canvas

## Data Binding

### Required Fields
- **Category**: Breakdown dimension (e.g. BatteryCode or Beat)
  - Data Type: Text/String
  - Purpose: Defines each segment in the waterfall visualization

- **Variance**: Per-category variance amount
  - Data Type: Numeric
  - Purpose: Represents the change amount for each segment

### Optional Fields
- **Start Value**: Opening total (e.g. forecast qty)
  - Data Type: Numeric
  - Purpose: Sets the initial baseline value for the waterfall

## Formatting Options

### Waterfall Settings
- **Positive Color**: Color for positive variance segments
- **Negative Color**: Color for negative variance segments
- **Total Color**: Color for start and end total segments
- **Connector Line**: Toggle connecting lines between segments
- **Connector Color**: Color for connector lines
- **Show End Total**: Toggle display of final total segment
- **Start Label**: Custom label for the starting point
- **End Label**: Custom label for the ending point
- **Bar Width**: Adjust width of waterfall segments
- **Orientation**: Choose Vertical or Horizontal layout

### Sort Settings
- **Sort By**: Choose sorting method:
  - Variance (High to Low)
  - Variance (Low to High)
  - Category (A-Z)
  - Absolute (High to Low)
- **Max Categories**: Limit number of displayed categories

### Label Settings
- **Show Values**: Toggle display of numeric values
- **Value Position**: Position labels (Inside, Outside, Auto)
- **Font Size**: Adjust label font size
- **Display Units**: Choose unit format (Auto, None, Thousands, Millions)
- **Decimal Places**: Set decimal precision
- **Value Font Color**: Custom color for value labels

### Axis Settings
- **Show Axis Labels**: Toggle axis label visibility
- **Axis Label Color**: Color for axis labels
- **Axis Label Font Size**: Font size for axis labels
- **Gridline Color**: Color for gridlines
- **Gridline Width**: Width of gridlines
- **Show Gridlines**: Toggle gridline visibility
- **Axis Line Color**: Color for axis lines
- **Show Axis Titles**: Toggle axis title visibility
- **X Axis Title**: Custom X axis title
- **Y Axis Title**: Custom Y axis title

## Features
1. **Waterfall Visualization**: Show cumulative impact of variances
2. **Customizable Segments**: Color-code positive, negative, and total segments
3. **Flexible Layout**: Switch between vertical and horizontal orientations
4. **Multiple Sorting Options**: Arrange categories by variance or alphabetically
5. **Value Display**: Show/hide numeric values with customizable positioning
6. **Connector Lines**: Visual connections between waterfall segments
7. **Cross-Filtering**: Click segments to filter other visuals
8. **Tooltips**: Hover for detailed segment information
9. **Responsive Design**: Adapts to different screen sizes

## Limitations
- Maximum of 30,000 data points supported
- Requires numeric variance measures
- Some formatting options require Power BI Premium

## Known Issues
None reported at this time.

## Support
For support, please visit: https://nexuscodex.nexus/support
GitHub repository: https://github.com/Nexus-Codex-pbi/codex-variance-waterfall
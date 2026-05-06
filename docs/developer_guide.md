# Developer Guide for Codex Variance Waterfall

## Architecture

### File Structure
```
src/
├── visual.ts              # Main visual implementation
├── settings.ts            # Formatting settings model
├── utils.ts               # Utility functions
├── style/visual.less      # CSS styling
└── assets/                # Icon and image assets
```

### Rendering Model
The visual uses D3.js for SVG-based rendering:
1. Data is parsed from Power BI's categorical data view
2. Waterfall bars are calculated with cumulative positions
3. SVG elements are created and positioned using D3 selections
4. Interactive elements are implemented as SVG elements with event handlers
5. Responsive layout adapts to container size changes

## Capabilities.json Summary

### Data Roles
- **Category**: Grouping role for waterfall bar creation
- **Start Value**: Measure role for baseline value
- **Variance**: Measure role for variance amounts

### Objects
- **waterfallSettings**: Main styling and behavior controls
- **sortSettings**: Sorting configuration options
- **labelSettings**: Label appearance settings
- **axisSettings**: Axis and gridline configuration

### Key Capabilities Enabled
- supportsHighlight: true
- supportsKeyboardFocus: true
- supportsLandingPage: true
- supportsEmptyDataView: true
- supportsMultiVisualSelection: true

## APIs Used

### Selection Manager
Used for cross-filtering functionality:
- `selectionManager.select()` for applying selections
- `selectionManager.showContextMenu()` for right-click context menus
- `selectionManager.registerOnSelectCallback()` for handling external selections

### Tooltip API
Provides hover information for all interactive elements:
- `tooltipService.show()` displays contextual data
- `tooltipService.hide()` removes tooltip on mouse leave

### Formatting Settings Service
Manages all user-configurable formatting options:
- `FormattingSettingsService.populateFormattingSettingsModel()` loads settings
- `getFormattingModel()` provides settings to Power BI formatting pane

### D3.js Library
Used for SVG manipulation and data binding:
- DOM selection and manipulation
- Data-driven rendering updates
- Scale calculations for proportional positioning
- Axis generation and gridline creation

## Performance Considerations

### Data Reduction
The visual implements Power BI's top count data reduction algorithm with a limit of 30,000 items to ensure responsiveness with large datasets.

### Efficient Rendering
Rendering optimizations include:
- SVG-based rendering for smooth scaling
- Minimal DOM manipulation through D3 data binding
- Calculated positions rather than complex layouts
- Smart text placement to avoid clipping

### Memory Management
- Proper event listener cleanup in visual lifecycle
- Selection state management without memory leaks
- Efficient data structure usage for parsed data

## Accessibility Implementation

### Semantic SVG
All SVG elements use appropriate structure:
- Group elements for logical organization
- Text elements with proper font sizing
- Descriptive labels and titles

### Keyboard Navigation
Full keyboard support implemented:
- Tab navigation to interactive elements
- Enter/Space activation of controls
- Proper focus management

### High Contrast Support
Dynamic adaptation to Windows High Contrast mode:
- Automatic color scheme switching
- Maintained contrast ratios for all elements
- Proper foreground/background color selection

## Security Compliance

### Sandboxed Execution
The visual runs entirely within Power BI's security sandbox:
- No external network requests
- No dynamic code execution
- No access to browser APIs outside Power BI framework

### Data Handling
All data processing occurs within Power BI's data flow:
- No data storage beyond current session
- No transmission of data outside Power BI service
- Proper handling of sensitive data through Power BI APIs

## Build & Packaging

### Dependencies
- powerbi-visuals-api: Official Power BI visuals SDK
- powerbi-visuals-utils-formattingmodel: Formatting settings utilities
- d3: Data visualization library
- d3-selection: DOM selection utilities
- d3-scale: Scale calculation utilities
- d3-array: Data manipulation utilities

### Build Process
Uses standard Power BI visual tools:
- pbiviz package for building and packaging
- TypeScript compilation with strict type checking
- LESS compilation for styling
- Minification for production builds

### Version Requirements
- API version: 5.11.0
- Compatible with Power BI Desktop and Service
# Test Plan for Codex Variance Waterfall

## Functional Tests

### Rendering Tests
- [ ] Visual renders correctly with all required data fields populated
- [ ] Visual shows empty state when no data is provided
- [ ] Visual shows landing page guidance when first added to canvas
- [ ] Waterfall bars render with correct heights/widths based on values
- [ ] Positive bars render in positive color
- [ ] Negative bars render in negative color
- [ ] Total bars render in total color
- [ ] Connector lines render when enabled
- [ ] Value labels render when enabled
- [ ] Axis labels render when enabled
- [ ] Axis titles render when enabled
- [ ] Gridlines render when enabled

### Formatting Tests
- [ ] Positive Color setting applies correctly to positive bars
- [ ] Negative Color setting applies correctly to negative bars
- [ ] Total Color setting applies correctly to total bars
- [ ] Connector Line toggle works correctly
- [ ] Connector Color setting applies correctly to connector lines
- [ ] Show End Total toggle works correctly
- [ ] Start Label setting displays correctly
- [ ] End Label setting displays correctly
- [ ] Bar Width setting adjusts bar dimensions
- [ ] Orientation setting switches between vertical/horizontal
- [ ] Sort By setting sorts categories correctly
- [ ] Max Categories setting limits displayed categories
- [ ] Show Values toggle works correctly
- [ ] Value Position setting positions labels correctly
- [ ] Font Size setting adjusts label text size
- [ ] Display Units setting formats values correctly
- [ ] Decimal Places setting formats decimals correctly
- [ ] Value Font Color setting applies to value labels
- [ ] Show Axis Labels toggle works correctly
- [ ] Axis Label Color setting applies to axis labels
- [ ] Axis Label Font Size setting adjusts axis label size
- [ ] Gridline Color setting applies to gridlines
- [ ] Gridline Width setting adjusts gridline thickness
- [ ] Show Gridlines toggle works correctly
- [ ] Axis Line Color setting applies to axis lines
- [ ] Show Axis Titles toggle works correctly
- [ ] X Axis Title setting displays correctly
- [ ] Y Axis Title setting displays correctly

### Interaction Tests
- [ ] Bar click triggers cross-filtering to other visuals
- [ ] Tooltip appears on hover with correct information
- [ ] Tooltip disappears on mouse leave
- [ ] Context menu appears on right-click
- [ ] Selection highlighting works correctly

### Data Tests
- [ ] Visual handles null/empty values gracefully
- [ ] Visual handles zero variance values correctly
- [ ] Visual handles negative numeric values correctly
- [ ] Visual handles large numeric values correctly
- [ ] Visual handles special characters in text fields
- [ ] Visual handles Unicode characters in text fields
- [ ] Visual sorts categories correctly by sort settings
- [ ] Visual limits categories correctly by max categories setting
- [ ] Visual handles maximum data limit (30,000 items)

## Performance Tests
- [ ] Visual loads within acceptable time with small dataset (<100 items)
- [ ] Visual loads within acceptable time with medium dataset (100-1000 items)
- [ ] Visual loads within acceptable time with large dataset (1000+ items)
- [ ] Visual maintains responsiveness during interaction
- [ ] Memory usage remains stable during repeated updates
- [ ] No memory leaks detected during extended testing

## Accessibility Tests
- [ ] Visual is fully navigable using keyboard only
- [ ] All interactive elements receive keyboard focus
- [ ] Focus indicators are clearly visible
- [ ] Screen reader can interpret visual content
- [ ] High contrast mode displays correctly
- [ ] Text scaling up to 200% works without clipping
- [ ] Color contrast meets WCAG 2.1 AA requirements

## Security Tests
- [ ] Visual makes no external network requests
- [ ] Visual does not execute dynamic JavaScript
- [ ] Visual handles data securely through Power BI APIs only
- [ ] Visual does not store sensitive data
- [ ] Visual does not access browser storage without permission

## Packaging Tests
- [ ] Visual package builds successfully
- [ ] Visual imports correctly into Power BI Desktop
- [ ] Visual functions correctly in Power BI Service
- [ ] Visual icon displays correctly in visualization pane
- [ ] Visual metadata displays correctly in marketplace

## Sample PBIX Verification
- [ ] Sample PBIX file loads without errors
- [ ] Visual renders correctly in sample file
- [ ] All data roles populate correctly with sample data
- [ ] Formatting options work correctly with sample data
- [ ] Interactions work correctly with sample data
- [ ] Cross-filtering works with other visuals in sample
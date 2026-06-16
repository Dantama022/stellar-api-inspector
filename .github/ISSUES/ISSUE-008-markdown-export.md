# ISSUE-008: Export Inspection Reports to Markdown

**EPIC:** 3 — Reports & Formats
**Labels:** `enhancement`, `good first issue`, `epic-reports`
**Difficulty:** easy

## Description

In addition to JSON output, users want to generate clean, readable Markdown summaries of Horizon or Account audits to include in documentation, GitHub issues, or wiki updates.

## Tasks

- [ ] Implement Markdown formatter for Horizon nodes and Account audits
- [ ] Add option `--format markdown` or check output file extension (`.md`)
- [ ] Render tables as standard GFM markdown tables
- [ ] Output the resulting markdown file to the specified `-o, --output` path

## Acceptance Criteria

- Executing `stellar-api-inspector account <accountId> -o report.md` creates a standard Markdown file
- File contains valid GFM markdown tables and header titles
- Tested with verify-file output assertions

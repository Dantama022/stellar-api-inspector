# ISSUE-004: Add JSON Output Format Option for Automation

**EPIC:** 3 — Reports & Formats
**Labels:** `enhancement`, `good first issue`, `epic-reports`
**Difficulty:** easy

## Description

The CLI output should be useful for shell piping and scripting. We need to implement a `--json` output option that prints structured, non-stylized JSON strings to stdout.

## Tasks

- [ ] Add `-j, --json` flag to all CLI subcommands
- [ ] Suppress ora spinners and chalk formatting when `--json` is selected
- [ ] Format and serialize inspection results into standard JSON payloads
- [ ] Test JSON output in CLI tests

## Acceptance Criteria

- Running with `--json` prints pure parsable JSON to stdout
- Return code remains unchanged
- Logs and progress indicators are printed to stderr or hidden

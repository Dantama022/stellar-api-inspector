# ISSUE-014: Command-line Interactive Prompt Mode

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** medium

## Description

To improve user experience for newcomers, the CLI should support an interactive guide mode using `inquirer`. When run without any subcommand (e.g., just `stellar-api-inspector`), the CLI should prompt the user to select an action, ask for parameters, and execute the inspection.

## Tasks

- [ ] Add `inquirer` dependency to `package.json`
- [ ] Implement interactive flow triggering if no arguments or commands are provided
- [ ] Provide choices: "Inspect Horizon", "Inspect Soroban", "Audit Account", "Endpoint Health Benchmark", "Exit"
- [ ] Query and pass answers to corresponding command runners

## Acceptance Criteria

- Running `stellar-api-inspector` (with no arguments) starts the interactive CLI prompts
- Selecting "Exit" closes cleanly
- Interactive inputs are validated (e.g. valid Horizon URL or Account ID formats)

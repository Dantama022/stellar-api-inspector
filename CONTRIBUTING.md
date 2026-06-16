# Contributing to Stellar API Inspector

Thank you for your interest in helping improve Stellar API Inspector! We design this tool to be accessible, performant, and developer-friendly.

This document outlines the workflow and guidelines for making contributions.

## Development Setup

### Prerequisites
- Node.js (>= 18.x)
- npm (>= 9.x)

### Local Installation
1. Fork and clone the repository.
2. Run `npm install` to install dependencies.
3. Verify your setup runs:
   ```bash
   npm run dev -- --help
   ```

### Code Formatting and Linting
We use ESLint and Prettier to enforce code style.
- Check code: `npm run lint`
- Auto-fix code formatting: `npm run format` & `npm run lint:fix`
- Perform TypeScript typecheck: `npm run typecheck`

### Testing
We use Jest for writing and running unit/integration tests.
- Run tests: `npm test`
- Run tests in watch mode: `npm run test:watch`

Please make sure all tests pass before submitting a Pull Request. If you add new functionality, please write accompanying Jest unit tests (using `nock` for network mocking if applicable).

## Contribution Flow

1. **Find an Issue**: Search our open issues in the backlog or look inside the `.github/ISSUES` folder.
2. **Create a Branch**: Create a feature branch off of the `dev` or `main` branch.
   - For bug fixes: `fix/issue-description`
   - For features: `feat/issue-description`
   - For docs: `docs/issue-description`
3. **Write Code**: Implement your changes, formatting, linting, and testing locally.
4. **Commit**: Keep commits small and write meaningful commit messages following conventional commits (e.g., `feat: add claimable balance checks`).
5. **Open a PR**: Submit a Pull Request targeting the `main` branch. Make sure to fill out the pull request template completely.

## Finding Tasks
We keep a catalog of pre-scoped developer issues in `.github/ISSUES/`. These are excellent starting points for new contributors, with difficulty levels ranging from `easy` to `hard`.

If you are looking to propose a new feature, please open a feature request issue first to discuss the design with the maintainers.

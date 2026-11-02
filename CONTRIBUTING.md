# Contributing

The most valuable contribution is a **signature**: a trailer, bot account, footer or branch prefix that an AI coding agent leaves by default.

1. Add it to `signatures/agents.json` (agent `id`, `kind`, a case-insensitive regular expression, `confidence` and a `note`).
   - `high`: only the agent produces it (a bot account, a vendor e-mail address, a fixed footer).
   - `medium`: the agent produces it by default, but a person could too (branch prefixes, a bare name).
2. Add a test to `test/classify.test.ts` with a real example, and a negative test if a human could match.
3. Put two or three public example links in the pull request.

Signals that only hint at AI use (writing style, emoji, commit size) are out of scope. howmuchai counts disclosure, not suspicion.

Run `npm ci && npm test && npm run typecheck` before opening a pull request.

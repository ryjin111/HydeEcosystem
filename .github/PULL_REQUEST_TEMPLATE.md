<!--
Thanks for contributing to Hyde. Please fill this out so the review is fast.
Security fixes: coordinate privately first — see SECURITY.md.
-->

## What & why

<!-- What does this change, and what problem does it solve? Link any related issue (Fixes #123). -->

## Area

- [ ] Frontend (launchpad UI)
- [ ] Contracts (Solidity / Foundry)
- [ ] Serverless API (IPFS pin / rate limit)
- [ ] Docs / README
- [ ] Other:

## Checks run (paste output or confirm)

- [ ] `npm run build` — type-checks and builds with no errors
- [ ] `forge test` (plain, **no `--match`**) — green (clean run: 55 pass / 1 skipped)
- [ ] I did not commit any secrets (`.env*`, keys, Filebase/KV creds)

## Anti-rug / immutability impact

- [ ] **No** change to the anti-rug guarantees (no runtime fee setter, no
      LP-withdraw path, no mint/burn/pause, no blacklist, no new owner power,
      no change to the hard-coded `hydeBps`/`liqBps`/90-5-5 split).
- [ ] This PR **does** touch one of the above — I've described the trade-off
      below and flagged it for a threat-model/spec review:

<!-- If checked, explain here: -->

## Notes for the reviewer

<!-- Anything else: screenshots for UI, new invariants/tests for contracts, follow-ups. -->

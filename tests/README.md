# Tests

**Offline:** `npm install`, then `npm test`. It builds `main.js`, runs the harnesses in `offline/`, and runs the randomized oracle, which compares the incremental results against a from-scratch computation after every edit. `main-2.2.0.js` is the old build the oracle compares against.

**Live:** the scripts in `live/` drive a real Obsidian through its debugging port, on a throwaway note `_cdp-test.md`.

1. Start Obsidian with `--remote-debugging-port=9222`, with your test vault open.
2. Set `OBSIDIAN_TEST_VAULT` to that vault's name, as in its window title, and run a script: `node tests/live/motions.mjs`. Most need Hebrew typing and Vim mode on.

`builtin-vim.mjs` needs Vim Motions off and Obsidian's Vim setting on, with the window reloaded. The live scripts can replace your open tab, so don't work in the vault while they run.

Some older live scripts report failures that are quirks of the scripts themselves: 18 of them, the same on every version since 2.7.1. Compare against the previous version before treating a failure as a regression.

# Any Language Math (BabelFish)

An Obsidian plugin for writing Hebrew notes with math. Notes read right to left, while math, code and frontmatter stay left to right, so formulas stay readable inside Hebrew sentences. It also lets you type Hebrew with your keyboard left on English, and has optional Vim support.

It's desktop only. It's built for Hebrew so far: other languages can be typed with a key map, but other right-to-left scripts, such as Arabic, don't yet make a note RTL on their own.

## What it does

- **Text direction.** A note with a Hebrew letter outside frontmatter, math and code is RTL. `direction: rtl` or `direction: ltr` in the frontmatter overrides that. Math, code and frontmatter stay LTR, in the editor and in Reading view.
- **Hebrew typing layer (off by default).** Keep the system keyboard on English. With the layer on, typed letters become Hebrew, except in math and code. It also covers an allowlist of fields: the quick switcher, command palette, search and note titles.
- **Vim mode (off by default, experimental).** Works best with the [Vim Motions](https://obsidian.md/plugins?id=vim-motions) plugin. Obsidian's own Vim mode gets all of this except jump labels and `gR`:
  - Vim commands stay English, while the layer also covers Replace mode (`R`, `gR`), the character after `f` `F` `t` `T` `r`, and the `/` and `?` prompts. The `:` prompt always stays English.
  - **Visual motions:** `h`, `l`, `<Left>`, `<Right>`, `x` and `X` move to the character next to the cursor as you see it, across Hebrew, formulas and wrapped lines. At the visual edge of a table cell, where that step couldn't move, `h`, `l` and the arrows step in text order instead.
  - With the system keyboard on Hebrew, normal-mode keys, `Ctrl+[` and jump labels still work.

No other plugins are needed. Direction and typing work without any Vim.

## Install

The plugin isn't in Obsidian's community plugins yet, so install it by hand:

1. Create the folder `.obsidian/plugins/babel-fish-math/` in your vault.
2. Put `main.js`, `manifest.json` and `styles.css` in it, from a release. To build `main.js` yourself, see Development.
3. Under **Settings → Community plugins**, turn off Restricted mode if it's on, then enable **Any Language Math (BabelFish)**.
4. Turn off Obsidian's own **Right-to-left** editor setting and any other RTL plugins, since they also set direction.

## Good to know

- **Brackets are mirrored, on purpose.** With the layer on, outside math and code, the `[` key types `]`, as on the Windows Hebrew layout. So a `[[link]]` needs `]]`. Turn the layer off for the syntax, or make a key map without mirroring.
- **The default map assumes a QWERTY keyboard.** For another layout, add a key map.
- **One Hebrew letter makes a note RTL,** including one in a tag or a link. Use `direction: ltr` in the frontmatter for an English note that mentions Hebrew.
- **A lone `$`,** as in `$5`, makes the rest of that line type English.

## Settings and hotkey

- **Toggle hotkey:** F12 by default. **Change** records the next key press (Esc cancels), **Clear** removes it, **Reset to F12** restores it. It goes by the physical key, so any keyboard layout gives the same result. A plain typing key is refused without Ctrl, Alt or Meta; function keys are fine.
- **The "Toggle Hebrew typing" command** stays in the palette and can get its own hotkey in Obsidian's Hotkeys. Don't use the same key in both, or it toggles twice. The EN / עב button in the status bar does the same.
- **Hebrew typing:** the same toggle, in the plugin's settings tab.
- **Key map:** what each key types. See below.
- **Layout warning:** shows a notice when the system keyboard is on Hebrew.
- **Vim mode (experimental, might be unstable):** turns the Vim support on or off at once, with no reload.
- **Visual h / l:** shown only in Vim mode. Off gives Vim's stock motions instead.
- **Diagnostics:** runs the self-checks on Obsidian's parser, and on Vim in Vim mode, shows a summary, and prints a table to the Console. A failed check turns off only the feature that needs it.

## Key maps

Maps are JSON files in `.obsidian/plugins/babel-fish-math/maps/`, which the plugin creates:

```json
{ "name": "QWERTY → Hebrew (SI-1452)", "keys": { "q": "/", "w": "'" } }
```

Each key and value is exactly one character. `qwerty.json` is the default, written from the copy built into the plugin. In the settings tab:

- **Key map:** switches between the valid maps, at once.
- **New:** copies the current map under a new name and switches to it.
- **Edit:** edits the current map's JSON, the default included. Invalid JSON is refused with the reason, and the file stays as it was.
- **Delete:** removes a map other than the default, after asking.
- **Reload:** reads the folder again, after you've edited the files outside Obsidian.
- **Reset default map:** rewrites `qwerty.json` from the built-in original, after asking.

An invalid file is skipped with a notice and never overwritten. If the current map is invalid or missing, the built-in original is used until you fix it and press Reload.

## Development

`src/core.js` is the plugin, `src/vim.js` holds everything for Vim, and `src/default-map.json` is the original key map. `main.js` is generated and isn't in git: `node build.mjs` joins them into it, with no dependencies, and fails if the core mentions a Vim internal or a name from `vim.js` other than `VimIntegration`. `node build.mjs --check` tells you whether `main.js` is up to date.

To work on it, make this repo the folder `.obsidian/plugins/babel-fish-math/` of a test vault. `npm install` and `npm test` run the offline tests. `tests/README.md` covers those and the live ones, and `docs/documentation.md` has the architecture, the rules for math and code, and known limits.

## License

[MIT](LICENSE)

## Do not push

**Never run `git push` — not for branches, not for tags, not `--force-with-lease` — unless
the user explicitly approves that push in the current turn.** The maintainer reviews every
commit before it reaches remote

The same applies to anything that publishes or rewrites shared state:

- `npm publish`, `npm version`, `npm dist-tag`
- rewriting history that already exists on the remote (`rebase`, `commit --amend` on pushed
  commits, `reset` of published commits, tag deletion or moving)
- creating or deleting remote branches

## Review gates before asking for a push

- `npm run check` (Biome + the checks in `tools/` + `tsc`) passes.
- Docs still match the code: `tools/config-docs-check.ts` covers the settings table; the
  layout table in `README.md` covers the files.
- No private infrastructure in the diff: no hostnames, IP addresses, absolute paths under a
  home directory, or credentials.

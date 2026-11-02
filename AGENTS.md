## Do not push

**Never run `git push` — not for branches, not for tags, not `--force-with-lease` — unless
the user explicitly approves that push in the current turn.** The maintainer reviews every
commit before it reaches remote

The same applies to anything that publishes or rewrites shared state:

- `npm publish`, `npm version`, `npm dist-tag`
- rewriting history that already exists on the remote (`rebase`, `commit --amend` on pushed
  commits, `reset` of published commits, tag deletion or moving)
- creating or deleting remote branches

## Changelog

Pi shows this package's changelog on the launch after an update. It reads `CHANGELOG.md` from the
package root and prints the version sections newer than the version it last recorded, under
"Extension Updates". `pi.changelogPath` points at another file, and `""` turns the changelog off.

Keep the file current:

- Land a user-facing change and its entry in the same commit. A change to the harnesses in `dev/`, or a
  new measurement that changes nothing for a session, gets no entry.
- Write the entry under `## Unreleased`. At a release, turn that section into a version heading and move
  the entries under it.
- Use the heading form `## X.Y.Z — YYYY-MM-DD`. Pi recognises only `## ` followed by three dot-separated
  numbers, so `## Unreleased` and `### A sub-heading` are not entries. Never put a `## ` line inside a
  version section: it ends the entry.
- Put the newest version first. Pi prints entries in file order.
- Bump `version` in `package.json` in the same commit as the new version heading. Pi records the
  `package.json` version, not the heading. A heading above the current version prints again on every
  launch, and a heading below it never prints.
- Keep `CHANGELOG.md` in the `files` list of `package.json`, so an npm install carries it. Pi reads the
  changelog from the installed package root.
- Write what a user would act on: a new setting, a changed default, a renamed key, a new command or tool,
  or a behaviour that changes what a session sees. Name the key and the value it replaces. Keep the
  measurement behind the decision in `DESIGN.md` or `RESULTS.md`.
- Do not use `npm version` for the bump. It creates a tag and can publish. Edit the field, and let the
  maintainer cut the tag.

## Review gates before asking for a push

- `npm run check` (Biome + the checks in `tools/` + `tsc`) passes.
- Docs still match the code: `tools/config-docs-check.ts` covers the settings table; the
  layout table in `README.md` covers the files.
- `CHANGELOG.md` has a version section matching the `version` in `package.json`, and the entries for this
  change are inside it.
- No private infrastructure in the diff: no hostnames, IP addresses, absolute paths under a
  home directory, or credentials.


## Do not add plans to git unless specifically ask to do


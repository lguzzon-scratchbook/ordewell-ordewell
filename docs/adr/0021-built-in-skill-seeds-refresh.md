# 0021 — Unedited built-in skill seeds refresh with the package

**Status:** accepted

## Context

Built-in skills are copied once into `~/.ordewell/skills/` and that copy wins
over the package version. The copy was never refreshed, so a fix to a built-in
(grilling's "one question at a time", commit `36d0254`) never reached anyone
who had already run Ordewell: their planner kept reading the old text.

## Decision

`SkillsService` records the SKILL.md hash of every seed it writes in
`~/.ordewell/skills/.seeded.json`. When the package's built-in differs from the
installed copy, the copy is replaced **only if** its hash still equals the
recorded one — the user never edited it. An edited copy is left alone.

Installs seeded before the manifest have no record, so a short table of
superseded built-in hashes (`PRIOR_BUILTIN_HASHES`) stands in for them. Seeds
written from now on need no table entry when a built-in changes.

## Rejected

- **Always prefer the package version.** Simplest, but silently discards a
  user's deliberate edits to a skill they own.
- **Never refresh; tell users to delete the copy.** The status quo; the bug
  above is what it costs.

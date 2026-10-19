## Context

Addresses on the bus are seats (`proj#3f9c1a20`) or project names (`proj`). Both are derived and
both die with a window. Fleet (set-core) keeps `~/.local/share/set-core/fleet-roster.json`:
`projects → session id → { label, cwd, project, last_seen }`, and a replacement window inherits
its predecessor's label (measured: `…-studio` held by `f0b9836a`, then by `1dc8f9fa`).

## Goals / Non-Goals

**Goals:** one human name reaches the live window it means; plain-language binding from inside a
window; the resolution is reported, never silent.

**Non-Goals:** renaming the native session (`/rename` is a typed slash command — Claude cannot run
it); writing to Fleet's files; a "lead" election among several windows of one project.

## Decisions

- **D1 — The book is declared state**, like `rooms.json`: written only by an explicit `alias` call,
  read by everyone. One shared file, rewritten whole on change (changes are rare and human-paced,
  so the lost-update race the heartbeat avoids does not apply).
- **D2 — Loose keys.** `aliasKey(name)` = NFD, combining marks stripped, lowercased, everything but
  letters and digits removed. Display keeps the name as given. An alias whose key equals an existing
  project or seat name is refused: it would shadow a real address.
- **D3 — Resolution order: seat/project (unchanged) → alias → Fleet label.** An existing address is
  never reinterpreted, so nothing that works today changes meaning.
- **D4 — A target kind decides how it survives.** `label` resolves to the live seat whose session
  holds that Fleet label now (survives replacement); `seat` is that seat only; `project` is the
  project's live seat, refused when there are several (listed with their labels). Binding THIS
  window stores `label` when the window has one, else `seat`, and the result says which.
- **D5 — Fleet is read, never required.** A missing or unparsable roster yields no labels; nothing
  errors. Read on each resolution (it is small and changes as windows open).
- **D6 — One seat per alias, always reported.** `send` gets `resolved: [{ asked, seat, via }]`;
  several live matches are an error naming them — fan-out to a project is what `to: project`
  already means, and an alias exists to avoid it.

## Risks / Trade-offs

- A label held by two live windows (Fleet allows a duplicate briefly) → pick the most recently seen
  and report it; the fallback is the error of D6 if they are equally recent.
- The skill's trigger phrases only reach projects whose installed skill copy is refreshed
  (`sac install` re-copies it).

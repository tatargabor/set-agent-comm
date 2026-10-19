## Decisions

- **D1 — One reserved word, `owner`.** Not a seat and not a project: `isForMe` ignores it, so a
  project that happened to be called `owner` cannot be addressed by it by accident, and an entry
  addressed only to `owner` is for no seat — it wakes nobody and is never rung (`wakes` returns
  false through `isForMe`). Addressed to `owner` and a seat, the seat is woken as usual.
- **D2 — The machine decides whose owner.** `owner` means the human of the machine reading it. The
  bridge sends a local `owner` as `owner@<namespace>`; the existing inbound translation
  (`localName`) turns `owner@<my namespace>` back into `owner` and leaves another machine's owner as
  written — so each owner sees only their own.
- **D3 — Open = no `re:` pointing at it, anywhere in the room.** One rule, no second store: an agent
  answering on the owner's behalf closes it, and so does the owner's own close, which is just an
  entry with that `re:` written as `owner` (the human's file in the room).
- **D4 — A named projection, versioned.** `sac.owner/1` lists exactly the fields above; `id` is
  `<ts>|<from>`, the identity the admin view already uses. Archived rooms are not read.
- **D5 — The room must be explicit when only `owner` is addressed.** Room inference works from who
  is in a room, and the owner is in every room of this machine; with several rooms, `send` asks.

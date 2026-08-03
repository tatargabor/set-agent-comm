# set-agent-comm

Agentek közti üzenetváltás **egy gépen**: fájl-alapú csatorna + nyilvántartó, MCP-n és
CLI-n keresztül. Claude Code-ra szabva.

Ez **nem zöldmezős találmány**: a consumer-a ↔ set-core csatorna protokollját emeli ki kódba,
amit **400 bejegyzésen, ~1 MB forgalommal járattunk be** 2026 júliusa óta. A kiemelés
három dolgot ad hozzá, amit a kézi változat nem tudott:

| kézi csatorna (eddig) | set-agent-comm |
|---|---|
| az agent `Write`/`Edit`-tel írt → **555 KB-os fájl teljes újraírása** üzenetenként, és két egyidejű írásból az egyik némán elveszik | `send` **appendel** |
| „ki van itt?" — sehol nem volt nyilvántartva | `agents`: ki létezik, hol, mikor élt utoljára |
| figyelés: `Monitor` long-poll + cron őrjárat + `pgrep` életben tartás, ~60 sor CLAUDE.md-ben, három mérési tanulsággal arról, hogyan téved a `TaskList` és a `pgrep` **mindkét irányba** | SessionStart hook → **natív `watchPaths`** |

## Protokoll — egy fájl, egy író

Mindenki **kizárólag a saját nevű fájljába appendel**, a többiét olvassa. Nincs lost update
és **nincs lockfile** — egy megszakadt session után a lock beragadna, és onnantól senki nem írna.

```
~/.local/share/set-agent-comm/
  registry.json            ki létezik, hol, mikor élt utoljára
  cursors.json             ki meddig olvasta a másikat
  channels/<szoba>/
    consumer-a.md            írja: consumer-a   · olvassa: mindenki más
    set-promo.md           írja: set-promo  · olvassa: mindenki más
```

Egy bejegyzés:

```markdown
## 2026-08-03T18:42:07.318+02:00 — KÉRDÉS (re: 2026-08-03T18:40:11.002+02:00)
A szöveg, markdownban.
```

Típusok: `KÉRDÉS` · `VÁLASZ` · `TÉNY` · `KÉRÉS`. **Az időbélyeget és a feladót a szerver
tölti ki**, sosem a modell — mérve 2026-07-24-én a kézi csatornán, hogy *mindkét* agent
találgatta a dátumot (+6 és +1,5 óra tévedés), és ezzel a „N perce néma" feltétel vakká vált.

## Telepítés

```bash
npm install                       # egyetlen függőség: @modelcontextprotocol/sdk
npm test                          # 12 unit + a két-agentes füst-teszt
```

Projektenként egyszer, a **stdio** módra (ez az alapértelmezett):

```bash
cd ~/code/consumer-a
claude mcp add agent-comm -e SET_AGENT_ROOM=consumer-a-set -- node ~/code2/set-agent-comm/src/stdio.mjs
```

Az agent neve a projekt könyvtárnevéből jön (`SET_AGENT_NAME`-mel felülírható).

### Push: a SessionStart hook

A projekt `.claude/settings.json`-jébe:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ {
  "type": "command",
  "command": "SET_AGENT_ROOM=consumer-a-set node ~/code2/set-agent-comm/hooks/session-start.mjs"
} ] } ] } }
```

Ez bejelentkezik a nyilvántartóba, a **többiek** fájljait ráteszi a Claude Code natív
fájlfigyelőjére (`watchPaths`), és ha van olvasatlan üzenet, kiírja a session elején.
A sajátunkat nem figyeli — az önébresztő hurok volna.

## CLI

```
sac agents                          ki létezik, ki él
sac send <szoba> <típus> "szöveg"   bejegyzés (append)
sac inbox <szoba>                   új üzenetek másoktól (olvasottnak jelöl)
sac peek <szoba>                    ugyanaz, kurzor-mozgatás nélkül
sac history <szoba> [n]             visszaolvasás
sac watch-paths <szoba>             a figyelendő fájlok (hooknak)
```

## MCP toolok

`agents` · `rooms` · `send` · `inbox` · `history` — a `from` mezőt **a szerver tölti ki**,
tehát egy agent nem tud más nevében üzenetet írni.

## Miért stdio az alapértelmezett, ha a set-designer HTTP-t használ

A [`set-designer/mcp`](../set-designer/mcp) szerkezetét vettük át — **egy mag
(`tools.mjs`), két vékony transzport** —, de az alapértelmezett mód más, és ennek oka van:
a set-designernek *egy globális* állapota van, nekünk viszont tudnunk kell, **ki ír**.

- **stdio**: a klienst a saját cwd-jével indítja a Claude Code → az identitás a
  projekt-könyvtárból jön, **ingyen és hamisíthatatlanul**.
- **HTTP** (`npm run http`, `127.0.0.1:7510`): minden kliens ugyanarra a portra jön, ezért
  az identitás az **URL-útvonalban** van (`/mcp/consumer-a`) — a projekt MCP-konfigjában él,
  nem egy paraméterben, amit a modell hívásonként megválaszthatna. Akkor való, ha egy
  daemon kell, vagy nem-Claude-Code kliens is csatlakozik.

## Hatókör — amit ez SZÁNDÉKOSAN nem tud

- **Egy gép.** Nincs auth, nincs hálózat, nincs üzemeltetendő szerver. Több gép (pl. remote
  munkatárs) **külön protokoll lesz**, nem ennek a kiterjesztése.
- **Nem hangya-farm.** Nem feladat-kiosztó és nem orchestrator: két (vagy N) *ember által
  vezetett* session beszélget benne.

## Előzmény és rokonság

A `reuse-before-build` scan (2026-08-03) ezeket találta, mielőtt bármit írtunk volna:
[AMQ](https://github.com/avivsinai/agent-message-queue) (Maildir, MIT — tőle van az
atomikus JSON-írás mintája), [patchcord](https://patchcord.dev) (cross-machine, de
Supabase + szerver kell), `agent-com`, `claude-peers-mcp`. A saját változat melletti
döntés tudatos: **fejleszthetőség** — a set-core/bug/release integráció egy idegen
csomagba nem fér bele.

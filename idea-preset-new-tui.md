# /preset new — le team composer dans le TUI

> **Statut 2026-07-12** : v0 livrée — schéma client-core synchronisé,
> `PUT /api/presets/:name` (validation bruyante + warnings, dont le
> warning parallel×local), écrans A et B, remix `n`/`from`/`edit`
> (commits `540515f`, `5cbcc15`). Reste ouvert : brief par membre,
> YAML, `create_preset` orchestrateur (§5), hook RoomForm (§3).

> Idée (2026-07-11) : amplifier `/preset new` pour composer une équipe complète
> sans quitter le terminal — membres, providers/modèles, outils, couleurs,
> system prompts, compaction, skills, thinking level, vision par agent.
> C'est la PersonaCard du site builder (cf. `idea.md` §1 et le screenshot du
> builder web) **adaptée aux idiomes TUI** : pas un formulaire géant, un flow.

---

## 1. État des lieux (ce qui existe déjà)

| Brique | Où | Ce qu'elle couvre |
|--------|----|-------------------|
| `/preset save <name>` / `/preset load` | `packages/tui/src/commands/registry.ts:751` | snapshot/restauration, rien de plus |
| `PresetPickerOverlay` | browse par nom → inspection des personas | lecture seule |
| `EditAgentForm` | nom, icône, couleur (palette 16), outils (toggle space) | identité seulement — ni model, ni prompt, ni thinking |
| `AgentForm` + `PersonaTemplate` | ajout d'agent depuis templates | id/name/color/icon/tools/model |
| `RoomForm` | preset + workdir + goal au `/newroom` | consomme les presets, ne les crée pas |

**Trou de schéma** (le vrai prérequis) : `PresetPersona`
(`packages/client-core/src/types.ts:135`) ne porte pas
`compactionInstructions`, `vision`, `skills` ni `icon`-groups — alors que
`PersonaDetail` les a (sauf `skills`). Impossible de composer une team
complète si le format de preset ne sait pas la stocker. → étendre
`PresetPersona` d'abord, en champs optionnels (les vieux presets restent
valides).

---

## 2. Le flow : deux écrans, comme un jeu

La carte web (screenshot) empile ~12 champs — intenable en un seul écran
terminal. Le TUI découpe en **deux niveaux**, navigation aller-retour :

### Écran A — le roster (niveau équipe)

```
┌ New preset: MonTeam ──────────────────────────────────┐
│  ▶ 📋 planner    high   Qwopus3.6-27B      7 tools  ● │
│    🔍 scout      med    DeepSeek V4 Flash  4 tools  ● │
│    🔨 builder    high   host default       9 tools  ●∥│
│    🛡  auditor    xhigh  claude-opus-4-6    3 tools  ○ │
│  ── + add member ──────────────────────────────────── │
│                                                        │
│  team: 4 members · 1 parallel lane · no web on builder│
│  ⏎ edit · a add · d duplicate · x delete · ↑↓/J K move│
│  s save preset · esc cancel                            │
└────────────────────────────────────────────────────────┘
```

- Une ligne par membre = la version condensée de la carte : emoji, id,
  thinking, modèle, nb d'outils, flags `●` active / `∥` parallel.
- `↑↓` navigue, `Shift+J/K` réordonne (l'équivalent des flèches ↑↓ de la
  carte web), `d` duplique (dériver un rôle), `x` supprime avec confirm.
- Ligne de **stats d'équipe** en bas — le mini-linter du site (§3 d'idea.md)
  version une ligne : trous d'outillage ("no web on builder"), lanes
  parallèles, ratio local/cloud. Réutiliser `roster-stats.ts`.
- `s` → nom du preset (TextInputOverlay) → écrit dans `presets/<name>.json`.

### Écran B — la carte membre (niveau persona)

`⏎` sur un membre ouvre l'éditeur pleine hauteur, **une section = un groupe
de champs**, `↑↓` entre champs, `tab` entre sections — c'est l'extension
naturelle d'`EditAgentForm`, pas un nouveau paradigme :

```
┌ Edit: planner ────────────────────────────────────────┐
│ IDENTITY                                               │
│  ▶ name      Planner                                   │
│    id        planner            (@mention)             │
│    emoji     📋                                        │
│    color     ‹ ■■ #5b8def ›     (palette, ←→)          │
│ TOOLS                                                  │
│    core      [read][bash][edit][write][grep][find][ls] │
│    web       [web_search][web_read][arxiv_search] …    │
│    orch      [spawn_room][check_room][answer_room] …   │
│ BRAIN                                                  │
│    model     ‹ 🏠 host default ›   (bench, ←→ + c=custom)│
│    thinking  ‹ high ›                                  │
│    vision    ‹ default (on) ›                          │
│    skills    orchestrator, webfetch                    │
│ PROMPTS                                                │
│    system    (canonical "planner" inherited) [e to edit]│
│    compaction Preserve all plans created… [e to edit]  │
│ FLAGS        [x] active   [ ] parallel                 │
│                                                        │
│  ↑↓ field · ←→ cycle · space toggle · e editor · esc ← │
└────────────────────────────────────────────────────────┘
```

Adaptations TUI des idées de la carte web :

- **Outils groupés** CORE / WEB / ORCHESTRATION comme sur le screenshot —
  le toggle-space d'`EditAgentForm` marche déjà, il suffit de grouper les
  rangées. Les groupes viennent du serveur (une map tool→groupe), pas
  codés en dur dans le client (garder le client mince — cf. client-core).
- **Couleur = palette, pas picker** — déjà la doctrine d'`EditAgentForm`
  ("a terminal wants a palette", slot 0 = couleur actuelle).
- **Model = le bench, pas un input libre** — `←→` cycle : `host default` →
  modèles des providers configurés → `custom…` (ouvre TextInput pour
  `provider/id` libre). C'est la Phase 2 d'idea.md §1bis, version cyclable.
- **System prompt en couches** (idea.md §8) : le champ affiche
  `(canonical "planner" inherited)` quand vide — taper remplace tout,
  comme le placeholder du screenshot le dit explicitement. `e` ouvre
  l'éditeur multi-ligne (PromptOverlay) ; en v1, `$EDITOR` externe pour
  les prompts longs (pattern git commit).
- **Compaction instructions** : même traitement — champ court tronqué,
  `e` pour l'éditeur.
- **Thinking** : cycle sur `off/minimal/low/medium/high/xhigh`, borné par
  `availableThinkingLevels` du modèle choisi quand connu.
- **Vision** : tri-état `default (on)` / `on` / `off` — le `undefined → true`
  de `PersonaDetail.vision` doit rester exprimable, sinon on ne peut pas
  dire "hérite".
- **Skills** : input CSV en v0 ; autocomplete sur les skills installés en v1.

---

## 3. Points d'entrée

- `/preset new` — roster vide + `+ add member` (templates `PersonaTemplate`
  comme graines, ou "blank").
- `/preset new from <name>` (ou `n` dans le PresetPickerOverlay) — **remix** :
  charge un preset existant dans le composer. Round-trip garanti,
  comme l'import du site.
- `/preset edit <name>` — même écran, sur un preset existant.
- Depuis `RoomForm` : `n` sur le champ preset → composer → retour au form
  avec le preset fraîchement créé sélectionné (le flow "je crée ma team au
  moment où j'en ai besoin").

---

## 4. Découpage technique

1. **Schéma d'abord** : étendre `PresetPersona` (`compactionInstructions?`,
   `vision?`, `skills?`) + endpoint de validation côté serveur. C'est le
   même chantier que le `preset-schema` partagé d'idea.md §6 — le TUI et
   le site doivent consommer LE MÊME contrat.
2. **Écran A** (roster + save) en réutilisant lineup/roster-stats — livrable
   seul : déjà utile pour réordonner/activer sans toucher au JSON.
3. **Écran B** = généralisation d'`EditAgentForm` (mêmes patterns focus/
   palette/toggle) branchée sur le state local du composer au lieu de
   PATCHer un agent live.
4. **Remix/edit** + entrée depuis RoomForm et PresetPickerOverlay.
5. v1 : `$EDITOR` externe, autocomplete skills, bench alimenté par le
   catalogue modèles (quand le `models.json` du site existera).

**Décision de design (tranchée 2026-07-12)** : le composer édite un
*document preset* (offline, pas besoin de room active), pas une room live
qu'on snapshot. Le composer doit marcher avant tout `/newroom`, sinon il
rate son cas d'usage principal (préparer la team avant de lancer). Et la
raison profonde est au §5 : le preset n'est pas un réglage du TUI, c'est
un **langage de description d'équipe** — le TUI n'en est qu'un des auteurs.

---

## 5. Le preset comme langage — l'orchestrateur auteur

Aujourd'hui `spawn_room({ preset: "local-default", goal })` ne prend qu'un
**nom** de preset existant (`docs/sub-rooms.md`) : l'orchestrateur consomme
des teams écrites par un humain, il ne sait pas en composer. L'étape
suivante, c'est de fermer cette asymétrie :

> « Hey Orchestrator, crée-moi une room custom avec 4 haiku en parallèle,
> chacun sur un fichier .ts différent, pour scouter le projet en vitesse. »

Ce que ça implique :

- **Le schéma de preset devient une surface d'outil.** Même contrat que
  §4.1, trois auteurs : le composer TUI, le site builder, et l'agent
  orchestrateur. C'est l'argument décisif pour le schéma partagé + endpoint
  de validation — pour un preset généré par LLM, le validateur n'est pas du
  confort, c'est le **garde-fou** (outil halluciné, modèle inconnu, id
  dupliqué → rejeté avant le spawn, avec une erreur que l'agent peut lire
  et corriger).
- **`spawn_room` accepte un team spec inline** en plus d'un nom de preset :
  `spawn_room({ team: {...}, goal })`. Nuance importante : l'exemple des
  4 haiku n'est pas un preset à *sauver*, c'est une **équipe éphémère** —
  même schéma, zéro persistance. Le format sert les deux : document durable
  dans `presets/`, ou spec jetable dans un appel d'outil.
- **`create_preset` en outil séparé** pour le cas durable : l'orchestrateur
  analyse le projet et propose une team taillée pour lui ("ce repo est un
  monorepo TS avec du CI lourd → voilà ta team"), écrite dans `presets/`,
  que l'humain peut ensuite ouvrir dans le composer (§2) pour ajuster. Le
  composer TUI devient l'éditeur de *relecture* des teams générées.
- **Le brief par membre manque au schéma.** "Chacun sur un fichier .ts
  différent" ne se code ni dans `systemPrompt` (identité durable) ni dans
  `goal` (niveau room). Il faut un champ `brief`/`assignment` par membre
  pour les squads éphémères — à prévoir dans l'extension de schéma de §4.1
  plutôt que de laisser l'orchestrateur bricoler ça dans les prompts.
- **Warning "parallel local" dans le validateur.** 4 haiku en parallèle =
  4 lanes cloud, aucun souci. La même team en full local tourne en
  *séquence* : llama-server est lancé en `--parallel 1` (et monter la
  valeur = overflow ctx sur 24GB, cf. CLAUDE.md). Le validateur doit
  avertir quand `parallel: true` × modèles locaux > capacité réelle du
  backend — "parallel demandé mais backend séquentiel" — pour que
  l'orchestrateur (ou l'humain) sache que le speed-up est illusoire.
- **YAML comme format d'export/génération.** Cible : preset exportable en
  YAML — plus lisible, commentable, et plus naturel à générer pour un LLM
  que du JSON strict. Le contrat reste le même (le JSON Schema de §4.1
  valide les deux) ; `presets/` peut accepter `.json` et `.yaml` côte à
  côte pendant la transition.

---

## 6. Pourquoi ça compte

Aujourd'hui, composer une team = éditer du JSON à la main ou passer par le
site. Le TUI est le flagship client (client mince sur client-core) : s'il ne
sait pas *créer* une équipe, il n'est que le player des presets des autres.
`/preset new` ferme la boucle — et le jour où la galerie du site existe,
`/import <url>` + `/preset edit` = le remix communautaire sans quitter le
terminal.

Et avec le §5, la boucle devient complète dans les deux sens : l'humain
compose des teams pour les agents, **les agents composent des teams pour
l'humain** — même schéma, même validateur, trois éditeurs (TUI, site,
orchestrateur). C'est le moment où le preset cesse d'être un fichier de
config et devient l'unité d'échange du projet.

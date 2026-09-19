# pipeline.daxzeit.eu — le "Dofusbook" de pipeline-MoE

> Idée d'origine : un site où l'on compose une équipe complète (membres, system
> prompts, outils, modèles, providers, emoji, couleurs) et qu'on exporte comme
> preset pipeline-MoE au format `presets/Versa.json`.

---

## 1. Le cœur : un team-builder visuel

Une page unique, sans compte, où l'on assemble une équipe persona par persona :

- **Carte persona** = un formulaire visuel calqué sur le schéma `Persona` de
  `src/types.ts` : id (slug @mention), nom, emoji, couleur, allowlist d'outils
  (checkboxes : read/bash/edit/write/grep/find/ls + outils web), `systemPrompt`
  (éditeur avec compteur de tokens), `model` ("provider/id"), `thinkingLevel`,
  `compactionInstructions`, `vision`, `skills`, `parallel`.
- **Roster strip** en haut qui reproduit visuellement le bandeau du TUI
  pipeline-MoE : on voit son équipe exactement comme elle apparaîtra dans
  l'app. C'est le moment "Dofusbook" — l'aperçu du perso équipé.
- Drag & drop pour réordonner, dupliquer une carte pour dériver un rôle.
- **Import = remix** : coller/uploader un preset existant (Versa.json, main.json…)
  le charge dans le builder. Garantie de round-trip : import → export identique.

Export : bouton "Download preset" → JSON strictement conforme, prêt à poser
dans `presets/`. Bonus : `Copy as command` → `curl -o presets/MonTeam.json <url>`.

## 1bis. Le flow RPG en deux phases : l'écurie d'abord, les rôles ensuite

Le choix du modèle ne doit pas être un `<select>` — c'est LE choix identitaire
d'un membre d'équipe, il mérite un écran de sélection de personnages.

**Phase 1 — l'écurie (champion select).**
Provider d'abord : on choisit son hébergeur (OpenRouter, Anthropic API,
local llama-server) et on parcourt ses **cartes modèles** :

- Logo/monogramme de l'éditeur (pas d'emoji), nom, id complet, lien
  **"model page ↗"** vers la fiche OpenRouter (providers, prix live, latence).
- **Données, pas d'opinion** (décision 2026-07-10 : le lore éditorial était
  biaisé) : la "classe" est un **tier de prix déclaré** — Frontier ≥ $20/1M
  out, Vanguard $3–20, Skirmisher < $3, Local Hero = gratuit. Affiché : ctx,
  prix in/out, badge vision, hébergeur.
- **Local = un champ "path to your local model"** (`local/<file>.gguf`), pas
  une carte curée — chacun amène son GGUF.
- On compose son **bench** : les modèles qu'on "recrute" pour ce build.
  Un build 100% local a un bench d'un seul héros — et ça se voit.

**Phase 2 — les rôles (le builder actuel).**
Sur chaque carte persona, le champ modèle n'est plus un input libre mais la
rangée des **mini-cartes du bench** — on assigne un héros à un rôle, comme on
place un personnage dans une formation. Le free-text "provider/id" reste en
mode avancé pour les modèles inconnus du catalogue.

Effets de bord vertueux :
- Le bench = la section `providers` implicite du preset ; le linter sait dire
  "ce build requiert une clé OpenRouter" avant même l'export.
- Les stats d'équipe (§3) découlent du catalogue : coût du build, équilibre de
  la composition (tout-frontier = cher, tout-flash = fragile) — la "théorie
  des builds" à la Dofusbook devient tangible.
- Le catalogue vit dans un `models.json` curé (v0), synchronisé plus tard
  depuis l'API OpenRouter + la liste llama-server locale (v2).

**Architecture du catalogue — pi en curateur, pas en backend.**
`GET https://openrouter.ai/api/v1/models` est public, sans clé, CORS `*`
(vérifié 2026-07-10) : le navigateur le fetch directement, le site reste 100%
statique. Les chiffres volatils (prix, contexte) viennent de là en live. Les
*jugements* (classe RPG, stat bars raisonnement/vitesse, blurbs) viennent d'un
`models.json` curé par **un job pi périodique** chez Dax : fetch du catalogue
brut (300+ modèles) → classification/curation par l'agent → snapshot embarqué
dans le site au build. Fetch live en échec ⇒ le snapshot suffit. Zéro serveur,
zéro machine exposée.

## 2. L'état dans l'URL (le vrai truc Dofusbook)

Toute l'équipe encodée dans le hash de l'URL (compressée, lz-string). Pas de
backend en v0 : partager un build = partager un lien. Chaque lien est un
permalien immuable, comme un build Dofusbook qu'on colle sur un forum/Discord.

## 3. Stats d'équipe — l'équivalent des stats d'équipement

Un panneau latéral qui "note" l'équipe en temps réel :

- **Coût estimé** : $/1M tokens par persona (catalogue de prix OpenRouter/
  Anthropic), agrégé. Badge **"100% local — 0 €"** pour les teams full llama.cpp.
- **Couverture d'outils** : radar read/write/exec/web — détecte les trous
  ("personne n'a `write`", "aucun accès web").
- **Ratio local/cloud**, nombre de personas vision-capable, lanes parallèles.
- **Linter de preset** : ids dupliqués, slug invalide, `vision: true` sur un
  modèle local sans mmproj, `compactionInstructions` manquant, systemPrompt
  vide. Le linter réutilise la vraie validation du repo (voir §6).

## 4. Galerie communautaire (v1)

- Publier son build (login GitHub, publication seulement — le builder reste
  sans compte) : nom, description, tags (`coding`, `research`, `budget-local`,
  `writing`, `full-cloud`…).
- Fork/remix en un clic avec lignée affichée ("remixé depuis Versa").
- Tri par votes, récents, coût. Recherche par tag/outil/modèle.
- **Image OG générée** par team (roster strip avec emojis/couleurs) → un lien
  partagé sur Discord/X montre l'équipe directement.
- Alternative v1 low-cost : registre = repo GitHub `pipeline-moe-presets`,
  publication = PR auto, le site lit le repo. Zéro base de données.

## 5. Archétypes de départ

Comme les "builds types" par classe sur Dofusbook, des templates d'entrée :

- **Dev Squad** (Versa-like : planner/scout/builder/auditor/tester/scribe)
- **Research Lab** (fetcher/scout lourds, scribe synthèse)
- **Budget Local** (tout sur Qwopus, thinking medium)
- **Writing Room**, **Solo+Reviewer**, etc.

Chaque archétype = un preset du repo, importé tel quel — les presets existants
(`presets/`) deviennent le contenu de lancement de la galerie.

## 6. Contrat de schéma partagé (le point technique clé)

Extraire le schéma de preset dans un package publié **`@pipeline-moe/preset-schema`**
(Zod + JSON Schema générés depuis `src/types.ts`/`src/validation.ts`) :

- Le site l'importe → il ne peut jamais exporter un preset invalide.
- pipeline-MoE l'importe → validation à l'import identique.
- Champ `presetVersion` pour évoluer sans casser les vieux liens.
- Effet de bord vertueux : ça force à combler l'écart actuel (Versa.json
  n'a même pas de `systemPrompt` alors que le type le déclare requis).

## 7. Import direct dans pipeline-MoE

- `pipeline import <url>` (ou `npx pipeline-moe import <url>`) : télécharge,
  valide, écrit dans `presets/`, propose le renommage en cas de collision.
- Dans le TUI : commande `/import <url>`.
- Le site affiche cette commande toute faite sous le bouton export.

## 8. Contenu qui rend le builder intelligent

- **Catalogue de modèles** synchronisé (OpenRouter API + liste locale + Anthropic) :
  autocomplete du champ `model`, prix, contexte, vision oui/non — ce qui
  alimente les stats du §3.
- **System prompts en couches** — le point qui rend un preset portable chez
  quelqu'un d'autre. Trois strates :
  1. **Prompt runtime pi** (invisible, imposé) — déjà le cas : `systemPrompt`
     est *appended* au prompt par défaut de pi (`src/types.ts:15`).
  2. **Prompt de rôle canonique** (imposé, versionné) — ce qui fait qu'un
     Planner planifie, qu'un Auditor ne code pas, que le handoff fonctionne.
     Maintenu par le projet, référencé par id (`basePrompt: "planner@1"`).
     Affiché en lecture seule (repliable) dans le builder : l'utilisateur voit
     ce qui est garanti, ne peut pas le casser.
  3. **Custom overlay** (libre) — le champ éditable de l'utilisateur : ton,
     domaine, conventions d'équipe, langue.

  À l'export, deux options : v0 concatène base + overlay dans `systemPrompt`
  (compatible avec le schéma actuel, avec marqueur de délimitation pour
  pouvoir ré-importer en couches) ; v2 du preset-schema porte
  `basePrompt`/`customPrompt` séparés et c'est l'app qui assemble — les
  presets restent valides quand le prompt canonique s'améliore.
- **Bibliothèque de system prompts** par rôle : snippets réutilisables et
  votables pour la couche *custom* (le vrai savoir-faire communautaire est
  là, pas dans les couleurs).
- **Skills** : le champ `skills` pointe vers agentskills.io — autocomplete et
  lien vers la description de chaque skill.

## 9. Phasage

| Phase | Contenu | Backend |
|-------|---------|---------|
| **v0** | Builder + import/export JSON + état dans l'URL + linter + roster preview | Aucun (site statique) |
| **v1** | Galerie, publish via GitHub, fork/remix, tags, OG images | Repo-registre ou Supabase minimal |
| **v2** | Stats/coûts live, catalogue modèles sync, bibliothèque de prompts, votes | Petit backend |

Stack suggérée v0 : site statique (SvelteKit/Astro + islands), aucune donnée
serveur, déployé sur le VPS existant derrière `pipeline.daxzeit.eu`.

## 10. Pourquoi ça compte

Le site devient **le funnel de découverte de pipeline-MoE** : on tombe sur un
build partagé, on le tripote dans le navigateur sans rien installer, et le
bouton export donne une raison d'installer l'app. Dofusbook n'était pas un
outil annexe de Dofus — c'était là que la théorie du jeu se faisait. Même pari
ici : le site est l'endroit où la communauté théorise "la bonne équipe".

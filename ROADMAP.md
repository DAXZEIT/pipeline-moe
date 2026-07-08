# Pipeline-MoE — Roadmap

> Maintenu par le planner. Backlog priorisé + registre de dette technique.
> Chaque clôture de plan verse ses follow-ups ici au lieu de les perdre dans le chat.
> Dernière mise à jour : 2026-07-09

---

## En cours / planifié

| Item | Plan | Statut |
|------|------|--------|
| _(rien en cours)_ | | |

## Backlog priorisé

1. **Politique de compaction des mémoires d'agents** — la section "Standing" de agent_memory/planner.md croît de façon monotone et se fait tronquer dans le prompt (observé 2026-07-08 : coupure en pleine phrase). Le scribe devrait archiver les entrées de plans complétés au-delà de N, garder les leçons en intégral. Artefact + consigne scribe, pas de code.
2. **Extraction opportuniste room.ts / server.ts** — 1795 et 2113 lignes. Pas de big-bang : chaque fois qu'une logique dupliquée est touchée, la factoriser dans le même commit. Précédent : drain loop dupliqué 4× (bug réel, pas smell).
3. **Pi API audit — Tier 2-3 restants** (`.pi/plans/pi-api-audit.md`) : sendCustomMessage avancé, cross-agent followUp, session tree, EventBus, dynamic providers.
4. **Plan-lint** (suggestion auditor, 2026-07-08) : avertir quand l'owner d'un step claimed poste N fois sans le compléter — mitigation ciblée de l'oscillation owner↔fallback (voir décision ci-dessous) si elle devient fréquente en pratique. Pas de détection runtime : un lint, pas un breaker.
5. **Hygiène des statuts de plans** : ~24 plans historiques non-complétés dont le statut oscille draft/active sans signification (constat empirique PLAN-c1874a35). Passe de nettoyage : marquer completed/archived les plans manifestement livrés ou abandonnés — réduit le bruit pour la sélection mtime du plan-aware routing.

## Dette technique / nettoyages opportunistes

- **Branche morte `goalStatus: "failed"`** dans le chemin d'abort de room.ts (`submit()` + `runGoalEval()`). Prouvée inatteignable par l'auditor (2026-07-08, PLAN-6aa1e63a) : l'unique `this.aborted = true` (dans `abortCurrent()`) pose toujours `goalCancelled = true` sous la même condition. Défensive, inoffensive. À nettoyer ou commenter au prochain passage sur room.ts.
- **`web/dist` et `packages/*/dist`** — artefacts rebuildés localement, gitignorés. RAS, noté pour mémoire.

## Décisions actées (ne pas rouvrir sans nouveau contexte)

- **Boucle d'orchestration fermée** (commit `cbffaa2`, release 0.1.22, 2026-07-09). spawn_room n'est plus fire-and-forget : rapport automatique dans la room parente à la résolution du goal (tour du spawner déclenché, passif si pause), `ask_orchestrator` dans toute sub-room spawnée (pause type ask_user, marche dans les boucles goal-eval), `answer_room` pour répondre/reprendre. Au passage, fix réel : runGoalEval écrasait une pause ask_user (queue orpheline). Limite connue : le ParentLink est en mémoire — après restart serveur, une sub-room restaurée ne rapporte plus (check_room reste).

- **Task board partagé livré** (commit `970841e`, release 0.1.21, 2026-07-09). Choix de dax : tasks room-scoped avec tools dédiés (`task_create/task_update/task_list`), PAS une simple projection du plan actif. Deux systèmes assumés : plans = contrat d'ingénierie global + routing ; board = couche d'orchestration vivante par room, visible en continu (TUI Ctrl+P + résumé sous roster, panneau sidebar web). Tools gated sur la présence du board, pas sur l'allowlist persona — les personas persistées d'avant la feature les reçoivent sans migration.

- **Turn-state tracking corrigé** (PLAN-ea321024, commit `50f9131`, release 0.1.20, 2026-07-09, 954/954). Les 3 bugs du test pipeline du 2026-07-08 : barre de statut suit l'agent réel (`turn {phase:"agent"}`), compact autorisé pendant une pause ask_user (`isGenerating()` — les 2 endpoints ET le slash `/compact`), label "paused" honnête TUI+web. **Fix 3b validé par dax** : une mention fraîche post-resume passe DEVANT la heldQueue (intention récente > continuation gelée) + notice d'ordre au resume. Rétro dans le plan.

- **Amplification comportementale du planner livrée** (PLAN-d5661224, commit `ab80c7f`, 2026-07-09). Texte overlay validé par dax tel quel : gate "faut-il le faire", 2-3 alternatives avant engagement, rétro de plan à la clôture, ownership du ROADMAP.

- **Plan-aware step routing livré** (PLAN-c1874a35, commits locaux `9de48c6` + `b3b0997`, 2026-07-08, 949/949, audit sans défaut). Convention `[owner]` en tête de step, sélection par mtime + filtre completed/archived (le status "active" est du bruit historique — grounding empirique). **Oscillation bornée connue** : si un owner ne complète jamais son step et ne mentionne personne, ping-pong owner↔fallback jusqu'à épuisement de maxChainHops. Accepté v1 — cohérent avec la philosophie post-circuit-breaker (bornage par hops, pas détection de motif). Mitigation si besoin : plan-lint (backlog n°4).

- **Circuit breaker supprimé** (PLAN-6aa1e63a, commit `22434e7`, 2026-07-08). Rationale : faux positifs ET faux négatifs sur sa population cible ; les filets réels sont max chain hops + fallback planner. Réintroduction : `git revert`.
- **Routing @-mention** : seul `@<name>` déclenche — parler d'un agent par son nom est sûr. Clarifié par dax 2026-07-08.

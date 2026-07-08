# Pipeline-MoE — Roadmap

> Maintenu par le planner. Backlog priorisé + registre de dette technique.
> Chaque clôture de plan verse ses follow-ups ici au lieu de les perdre dans le chat.
> Dernière mise à jour : 2026-07-08

---

## En cours / planifié

| Item | Plan | Statut |
|------|------|--------|
| Plan-aware step routing — le plan orchestre, le planner planifie | PLAN A (voir .pi/plans) | planifié |
| Amplification comportementale du planner (alternatives, gate "faut-il", rétro de plan) | PLAN B (voir .pi/plans) | planifié, dépend de A (conflit personas.ts) |

## Backlog priorisé

1. **Politique de compaction des mémoires d'agents** — la section "Standing" de agent_memory/planner.md croît de façon monotone et se fait tronquer dans le prompt (observé 2026-07-08 : coupure en pleine phrase). Le scribe devrait archiver les entrées de plans complétés au-delà de N, garder les leçons en intégral. Artefact + consigne scribe, pas de code.
2. **Extraction opportuniste room.ts / server.ts** — 1795 et 2113 lignes. Pas de big-bang : chaque fois qu'une logique dupliquée est touchée, la factoriser dans le même commit. Précédent : drain loop dupliqué 4× (bug réel, pas smell).
3. **Pi API audit — Tier 2-3 restants** (`.pi/plans/pi-api-audit.md`) : sendCustomMessage avancé, cross-agent followUp, session tree, EventBus, dynamic providers.

## Dette technique / nettoyages opportunistes

- **Branche morte `goalStatus: "failed"`** dans le chemin d'abort de room.ts (`submit()` + `runGoalEval()`). Prouvée inatteignable par l'auditor (2026-07-08, PLAN-6aa1e63a) : l'unique `this.aborted = true` (dans `abortCurrent()`) pose toujours `goalCancelled = true` sous la même condition. Défensive, inoffensive. À nettoyer ou commenter au prochain passage sur room.ts.
- **`web/dist` et `packages/*/dist`** — artefacts rebuildés localement, gitignorés. RAS, noté pour mémoire.

## Décisions actées (ne pas rouvrir sans nouveau contexte)

- **Circuit breaker supprimé** (PLAN-6aa1e63a, commit `22434e7`, 2026-07-08). Rationale : faux positifs ET faux négatifs sur sa population cible ; les filets réels sont max chain hops + fallback planner. Réintroduction : `git revert`.
- **Routing @-mention** : seul `@<name>` déclenche — parler d'un agent par son nom est sûr. Clarifié par dax 2026-07-08.

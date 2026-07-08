# Pipeline-MoE — Roadmap

> Maintenu par le planner. Backlog priorisé + registre de dette technique.
> Chaque clôture de plan verse ses follow-ups ici au lieu de les perdre dans le chat.
> Dernière mise à jour : 2026-07-08 (soir)

---

## En cours / planifié

| Item | Plan | Statut |
|------|------|--------|
| Amplification comportementale du planner (alternatives, gate "faut-il", rétro de plan) | PLAN-d5661224 | en cours — overlay en validation dax |

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

- **Plan-aware step routing livré** (PLAN-c1874a35, commits locaux `9de48c6` + `b3b0997`, 2026-07-08, 949/949, audit sans défaut). Convention `[owner]` en tête de step, sélection par mtime + filtre completed/archived (le status "active" est du bruit historique — grounding empirique). **Oscillation bornée connue** : si un owner ne complète jamais son step et ne mentionne personne, ping-pong owner↔fallback jusqu'à épuisement de maxChainHops. Accepté v1 — cohérent avec la philosophie post-circuit-breaker (bornage par hops, pas détection de motif). Mitigation si besoin : plan-lint (backlog n°4).

- **Circuit breaker supprimé** (PLAN-6aa1e63a, commit `22434e7`, 2026-07-08). Rationale : faux positifs ET faux négatifs sur sa population cible ; les filets réels sont max chain hops + fallback planner. Réintroduction : `git revert`.
- **Routing @-mention** : seul `@<name>` déclenche — parler d'un agent par son nom est sûr. Clarifié par dax 2026-07-08.

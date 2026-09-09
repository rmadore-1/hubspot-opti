# hubspot-opti

Outils pour réduire les actions répétitives sur les fiches contact HubSpot.

## `userscript/hubspot-quick-call-log.user.js`

Userscript Tampermonkey qui qualifie l'appel ouvert sur une fiche contact en un
raccourci clavier, au lieu de dérouler deux menus à la souris.

Actions jouées (dans l'ordre) :

1. **Type d'appel** → `Call Commercial : prospection`
2. **Résultat de l'appel** → `Répondeur/Pas de réponse`

### Pourquoi un userscript et pas l'API

Le script pilote l'UI HubSpot déjà authentifiée dans le navigateur. Conséquence :
**aucun token à stocker**, aucun scope à provisionner, et HubSpot applique sa
propre logique de sauvegarde et de validation. Le prix à payer est la fragilité —
un changement de DOM côté HubSpot casse le ciblage. C'est assumé : cet outil est
un banc d'essai pour valider le gain de temps avant de porter la logique dans la
private app (voir *Suite* plus bas).

### Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox).
2. Tableau de bord Tampermonkey → **Utilitaires** → *Importer depuis un fichier*,
   ou onglet **+** puis coller le contenu de `hubspot-quick-call-log.user.js`.
3. Enregistrer, vérifier que le script est activé.
4. Ouvrir une fiche contact HubSpot : la console affiche
   `[hs-quick-call] chargé` et un bouton **⚡ Qualifier l'appel** apparaît en bas
   à droite.

Le `@match` couvre `app.hubspot.com`, `app-eu1.hubspot.com` et
`app-na1.hubspot.com`. Si ton portail est sur un autre domaine, ajoute-le.

### Utilisation

| Raccourci      | Effet                                                     |
| -------------- | --------------------------------------------------------- |
| `Ctrl+Shift+K` | Joue les actions sur l'appel ouvert                        |
| `Ctrl+Shift+J` | **Mode sonde** — dump les champs détectés dans la console  |
| Bouton flottant| Même effet que `Ctrl+Shift+K`, pratique pour les tests     |

L'éditeur d'appel doit être ouvert (appel sélectionné et déplié dans la
chronologie) avant de déclencher le raccourci.

Un bandeau en bas à droite indique la progression : bleu pendant l'exécution,
turquoise si tout est passé, rouge en cas d'échec avec le nom de l'action fautive.

### Si ça ne trouve pas les champs

Les sélecteurs sont volontairement **basés sur les libellés visibles** plutôt que
sur les classes CSS (obfusquées et instables chez HubSpot). Si un champ n'est pas
trouvé :

1. Ouvrir l'éditeur d'appel, presser `Ctrl+Shift+J`.
2. Lire la console : elle liste les libellés candidats, le déclencheur retenu
   pour chaque action, et tous les menus visibles de la page avec leurs
   `data-test-id`.
3. Ajuster `CONFIG.actions[].field` avec le libellé réellement affiché, ou
   `CONFIG.actions[].value` avec l'intitulé exact de l'option.

La comparaison ignore la casse, les accents et les espaces autour des `:`, donc
`Call commercial: Prospection` matche `Call Commercial : prospection`.

Pour tester une action isolément depuis la console :

```js
await hsQuickCall.selectValue(hsQuickCall.CONFIG.actions[1]);
hsQuickCall.findTrigger(["résultat de l'appel"]);
hsQuickCall.visibleOptions().map(o => o.textContent);
```

### Configuration

Tout est regroupé dans l'objet `CONFIG` en tête de fichier :

| Clé           | Rôle                                                              |
| ------------- | ----------------------------------------------------------------- |
| `actions`     | Liste ordonnée `{ name, field[], value }`                          |
| `autoSave`    | Clique *Enregistrer* après les actions. `false` par défaut         |
| `hotkey`      | Raccourci de déclenchement                                         |
| `probeHotkey` | Raccourci du mode sonde                                            |
| `showButton`  | Affiche le bouton flottant                                         |
| `timeoutMs`   | Attente max pour l'apparition d'un champ ou d'une option           |

`autoSave` est à `false` volontairement : garde la main sur la sauvegarde tant
que tu n'as pas vérifié que les deux menus se remplissent correctement.

### Limites connues

- **Fragile par nature** : dépend du DOM de l'app HubSpot, qui change sans préavis.
- **Non partageable proprement** : chaque personne de l'équipe doit installer
  Tampermonkey et le script. Pas de déploiement centralisé, pas de versioning.
- **Pas de garde-fou** : le script ne vérifie pas qu'il agit sur le bon appel. Il
  cible le premier éditeur visible contenant les champs attendus.
- **Deux actions sur quatre** : les deux autres actions du workflow restent à
  spécifier.

## Suite

Le userscript sert à mesurer le gain réel. Une fois validé, la logique se porte
dans la private app existante :

- **UI extension** (`@hubspot/ui-extensions`) — bouton natif sur la fiche contact,
  appelant une serverless function qui écrit `hs_activity_type` et
  `hs_call_disposition` sur l'objet Call via l'API CRM v3. Nécessite Sales Hub ou
  Service Hub Enterprise.
- Attention : `hs_call_disposition` attend un **GUID**, pas un libellé. Il faudra
  récupérer l'identifiant réel de `Répondeur/Pas de réponse` dans le portail
  (endpoint des dispositions d'appel), les valeurs par défaut de HubSpot ne
  couvrant pas les dispositions personnalisées.

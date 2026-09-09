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

### L'app HubSpot est un empilement d'iframes

C'est le point qui gouverne l'architecture du script. La fiche contact
(`/contacts/.../record/...`) et le widget d'appel (`/calling/.../twilio`, app
`calling-widget-ui`) sont des **documents séparés**. Un script qui ne regarde
qu'un seul `document` ne voit donc pas forcément les champs.

Le script est injecté dans chaque frame. Celle qui contient réellement les deux
champs se déclare et exécute les actions ; les autres restent passives. Le
pilotage — bouton flottant, bandeau d'état, collecte de la sonde — vit dans la
frame principale et communique avec les autres par `postMessage`. Le raccourci
clavier est écouté partout, puisque le focus peut être dans le widget d'appel.

Conséquence pratique : **le raccourci marche quel que soit l'endroit où tu as
cliqué en dernier**, et la sonde agrège les rapports de toutes les frames.

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

| Raccourci / bouton      | Effet                                            |
| ----------------------- | ------------------------------------------------ |
| `Ctrl+Shift+K`          | Joue les actions sur l'appel ouvert               |
| `Ctrl+Shift+J`          | **Mode sonde** — ouvre le rapport de détection    |
| ⚡ Qualifier l'appel     | Idem `Ctrl+Shift+K`                               |
| 🔍                      | Idem `Ctrl+Shift+J`                               |

Les raccourcis utilisent `Ctrl`, y compris sur macOS : `Cmd+Shift+J` et
`Cmd+Shift+K` sont déjà pris par les consoles de Firefox. Les deux boutons
flottants évitent le clavier si tu préfères.

L'éditeur d'appel doit être ouvert (appel sélectionné et déplié dans la
chronologie) avant de déclencher le raccourci.

Un bandeau en bas à droite indique la progression : bleu pendant l'exécution,
turquoise si tout est passé, rouge en cas d'échec avec le nom de l'action fautive.

### Comment une option est identifiée

La page HubSpot contient en permanence des dizaines d'éléments qui ressemblent à
des options : la navigation latérale (`[class*="menu"] li`), les listes de
propriétés (`[data-test-id*="option"]` — un champ nommé `options_co_logiciel_ia`
matche). Chercher l'option dans toute la page reviendrait à risquer un clic sur
un élément de navigation portant le même libellé.

Le script photographie donc les candidats **avant** d'ouvrir le menu et ne
retient ensuite que ce qui est apparu depuis. Trois passes, dans l'ordre :

1. éléments nouveaux portant un rôle ARIA d'option ;
2. éléments nouveaux au sens large (composants sans rôle) ;
3. en dernier recours, rôle ARIA strict sur toute la page — pour le cas où le
   menu était déjà ouvert avant le clic, donc absent du diff.

Après le clic, le script **relit le champ et vérifie que la valeur a pris**. Si
elle ne se confirme pas en deux secondes, il continue mais le bandeau le signale
plutôt que d'annoncer un succès. Un champ déjà à la bonne valeur n'est pas
rouvert.

### Si ça ne trouve pas les champs

Les sélecteurs sont volontairement **basés sur les libellés visibles** plutôt que
sur les classes CSS (obfusquées et instables chez HubSpot). Si un champ n'est pas
trouvé :

1. Ouvrir l'éditeur d'appel, presser `Ctrl+Shift+J`.
2. La sonde interroge toutes les frames et ouvre un **panneau avec le rapport
   déjà sélectionné** — `Cmd+C` suffit. Il liste, frame par frame : les
   libellés candidats, le déclencheur retenu pour chaque action, tous les menus
   visibles avec leurs `data-test-id`, et les options ouvertes.

   Le rapport n'est délibérément pas copié automatiquement :
   `navigator.clipboard` exige une activation utilisateur transitoire, or la
   collecte inter-frames est asynchrone — au moment de copier, le geste a
   expiré et l'appel est rejeté. Le bouton *Copier* du panneau, lui, s'exécute
   dans un vrai handler de clic et fonctionne.
3. Ajuster `CONFIG.actions[].field` avec le libellé réellement affiché, ou
   `CONFIG.actions[].value` avec l'intitulé exact de l'option.

Le rapport est aussi imprimé dans la console et disponible dans
`window.__hsProbe`.

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
- **La sauvegarde reste manuelle** tant que `autoSave` est sur `false`.

## Tests

`npm test` joue le script contre un DOM simulé (jsdom) qui reproduit la
structure de l'éditeur d'appel : libellé + bouton déclencheur, menu rendu dans
un portail attaché au `body`.

```
npm install
npm test
```

Ce harnais valide la mécanique — détection par libellé, ouverture du menu,
sélection de l'option, tolérance à la casse et aux accents, échecs propres. Il
**ne valide pas** que les sélecteurs correspondent au vrai DOM HubSpot : seule
la sonde sur le portail réel le dit. Son intérêt est de pouvoir modifier la
logique sans repasser par un test manuel à chaque itération.

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

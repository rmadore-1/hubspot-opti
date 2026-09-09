# hubspot-opti

Outils pour réduire les actions répétitives sur les fiches contact HubSpot.

## `userscript/hubspot-quick-call-log.user.js`

Userscript Tampermonkey qui qualifie l'appel ouvert sur une fiche contact en un
raccourci clavier, au lieu de dérouler deux menus à la souris.

Actions jouées (dans l'ordre) :

Les valeurs et les raccourcis se configurent depuis l'interface. La combinaison
livrée par défaut est *Répondeur / Prospection* :

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

En bas à droite : un bouton par combinaison **affichée**, plus un bouton ⚙️. Les
boutons sont atténués au repos et redeviennent pleins au survol.

| Geste                  | Effet                                                |
| ---------------------- | ---------------------------------------------------- |
| Clic sur une combinaison | Applique ses valeurs à l'appel ouvert              |
| Son raccourci          | Idem, sans quitter le clavier                         |
| ⚙️                     | Ouvre le panneau de gestion des combinaisons          |

Une combinaison est un ensemble de valeurs (`Type d'appel`, `Résultat de
l'appel`) et, facultativement, un raccourci. Celle livrée par défaut est
*Répondeur / Prospection*.

### Gérer les combinaisons

Le panneau ⚙️ liste les combinaisons. Pour chacune :

- **l'œil** — affiche ou masque son bouton en bas de page. Une combinaison
  masquée reste pilotable par son raccourci : l'œil ne gouverne que la barre.
  Seule la première est affichée au départ, les combinaisons créées ensuite
  naissent masquées pour ne pas encombrer l'écran ;
- **le nom**, éditable directement ;
- **le bouton raccourci** — cliquer dessus met le bouton en écoute : les
  modificateurs s'affichent au fur et à mesure que tu les enfonces (`Ctrl+…`),
  la combinaison est retenue dès que tu ajoutes une vraie touche. `Échap`
  annule, et un raccourci déjà pris par une autre combinaison est refusé ;
- **Absorber** — recopie dans la combinaison ce qui est *actuellement posé sur
  l'appel ouvert* ;
- **Supprimer**.

Le bouton **+ Ajouter depuis l'appel courant** crée une combinaison à partir de
l'appel ouvert, nommée d'après les valeurs absorbées.

L'absorption évite de retaper les libellés exacts — « Call Commercial :
prospection » avec ses espaces autour du deux-points est précisément le genre de
chaîne qu'on saisit mal. Elle ignore les champs vides : le texte « Sélectionner »
n'est pas absorbé comme une valeur.

Les champs n'étant pas forcément dans la frame principale, l'absorption passe par
un aller-retour `postMessage` : la frame qui les porte répond avec ce qu'elle lit.

Tout est mémorisé dans le `localStorage` du navigateur (`hsQuickCall.presets.v1`)
et propagé aux iframes, qui écoutent aussi le clavier. Le raccourci unique des
versions antérieures est repris automatiquement.

Une touche nue est refusée : sans `Ctrl`, `Alt` ou `Cmd`, tu la déclencherais en
tapant une note. Le raccourci par défaut utilise `Ctrl` même sur macOS —
`Cmd+Maj+K` est déjà pris par la console de Firefox.

### Comment une option est identifiée

La page HubSpot contient en permanence des dizaines d'éléments qui ressemblent à
des options : la navigation latérale (`[class*="menu"] li`), les listes de
propriétés (`[data-test-id*="option"]` — un champ nommé `options_co_logiciel_ia`
matche). Chercher l'option dans toute la page reviendrait à risquer un clic sur
un élément de navigation portant le même libellé.

Pire : l'affichage des valeurs courantes porte lui-même `role="option"`. Un span
« Répondeur/Pas de réponse » existe sur la page **avant tout clic**. Chercher
l'option dans le document entier reviendrait à cliquer ce span.

Le script photographie donc les candidats **avant** d'ouvrir le menu et ne
retient ensuite que ce qui est apparu depuis — d'abord les éléments portant un
rôle ARIA d'option, puis au sens large pour les composants qui n'en posent pas.
Il n'y a **pas** de repli sur la page entière, précisément à cause de ces leurres.

Si le menu était déjà ouvert avant le clic, il figure dans la photo « avant » et
le diff ne voit rien. Le clic l'ayant refermé (les menus basculent), le script
retente une fois : la seconde photo part alors d'un état fermé.

Après le clic, le script **relit le champ et vérifie que la valeur a pris**. Si
elle ne se confirme pas en deux secondes, il continue mais le bandeau le signale
plutôt que d'annoncer un succès. Un champ déjà à la bonne valeur n'est pas
rouvert.

### Si ça ne trouve pas les champs

Les sélecteurs sont volontairement **basés sur les libellés visibles** plutôt que
sur les classes CSS (obfusquées et instables chez HubSpot). Si un champ n'est pas
trouvé :

1. Ouvrir l'éditeur d'appel, puis dans la console : `hsQuickCall.probe()`.
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

La sonde n'a volontairement ni bouton ni raccourci : c'est un outil de
diagnostic, pas un geste quotidien. Elle reste appelable à tout moment par
`hsQuickCall.probe()`.

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
| `fields`         | Champs que le script sait lire et remplir (`name` + `labels`)   |
| `defaultPresets` | Combinaisons livrées, utilisées au premier lancement            |
| `autoSave`       | Clique *Enregistrer* après les actions. `false` par défaut      |
| `showButtons`    | Affiche la barre de boutons                                     |
| `buttonOpacity`  | Opacité des boutons au repos (`0.72`), pleine au survol         |
| `timeoutMs`      | Attente max pour l'apparition d'un champ ou d'une option        |

Au quotidien tu n'as plus à toucher au fichier : les combinaisons se gèrent
depuis ⚙️. `CONFIG.fields` n'est à modifier que pour apprendre au script un
**nouveau champ** (au-delà du type et du résultat d'appel).

`autoSave` est à `false` volontairement : garde la main sur la sauvegarde tant
que tu n'as pas vérifié que les deux menus se remplissent correctement.

### Limites connues

- **Fragile par nature** : dépend du DOM de l'app HubSpot, qui change sans préavis.
- **Non partageable proprement** : chaque personne de l'équipe doit installer
  Tampermonkey et le script. Pas de déploiement centralisé, pas de versioning.
- **Pas de garde-fou** : le script ne vérifie pas qu'il agit sur le bon appel. Il
  cible le premier éditeur visible contenant les champs attendus.
- **La sauvegarde reste manuelle** tant que `autoSave` est sur `false`.
- **Les combinaisons sont locales au navigateur** : elles ne suivent ni le
  profil HubSpot ni les autres postes.

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

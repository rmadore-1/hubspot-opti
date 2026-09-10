# LazyQ

Qualifie un appel HubSpot en un clic ou un raccourci clavier, au lieu de
dérouler deux menus à la souris sur chaque fiche contact.

Une **combinaison** est un ensemble de valeurs de champs (`Type d'appel`,
`Résultat de l'appel`) avec un raccourci facultatif. Celle livrée par défaut est
*Répondeur / Prospection*. Les suivantes se créent depuis l'interface, sans
toucher au code.

Le projet se décline en deux formes, à partir du **même code** :

| | |
| --- | --- |
| `userscript/lazyq.user.js` | La source, utilisable telle quelle dans Tampermonkey |
| `extension/` | Extension Chrome / Firefox — **générée**, ne pas éditer à la main |
| `docs/installation.html` | Notice pour l'équipe — **générée**, embarque le script |

## Installer l'extension

Ne garde qu'une seule des deux formes active : le userscript et l'extension
injectent le même code, et tu obtiendrais deux barres de boutons.

**Chrome / Edge** (111 ou plus) — `chrome://extensions` → activer *Mode
développeur* → *Charger l'extension non empaquetée* → choisir le dossier
`extension/`. Chrome signale `Unrecognized manifest key
'browser_specific_settings'` : c'est la clé destinée à Firefox, sans effet ici.

**Firefox** (128 ou plus) — `about:debugging#/runtime/this-firefox` → *Charger
un module temporaire* → choisir `extension/manifest.json`.

Le mot *temporaire* est à prendre au pied de la lettre : Firefox retire
l'extension au redémarrage. Pour une installation durable il faut une extension
signée — soit la soumettre à addons.mozilla.org en distribution *unlisted* pour
récupérer un `.xpi` signé, soit utiliser Developer Edition ou Nightly avec
`xpinstall.signatures.required` à `false`. Chrome, lui, garde une extension
chargée non empaquetée d'une session à l'autre.

## Installer le userscript (alternative)

Tampermonkey → *Créer un nouveau script* → coller le contenu de
`userscript/lazyq.user.js` → `Ctrl+S`. Aucune construction nécessaire, c'est le
fichier source.

C'est la voie recommandée pour l'équipe : Tampermonkey étant lui-même signé,
l'installation est permanente sur Firefox, sans passer par AMO.
`docs/installation.html` est la notice à leur transmettre — elle embarque le
script avec un bouton de copie, et se régénère avec `npm run build`.

## Utilisation

En bas à droite : un bouton par combinaison **affichée**, plus un bouton ⚙️. Les
boutons sont atténués au repos et redeviennent pleins au survol.

| Geste | Effet |
| --- | --- |
| Clic sur une combinaison | Applique ses valeurs à l'appel ouvert |
| Son raccourci | Idem, sans quitter le clavier |
| ⚙️ | Ouvre le panneau de gestion |

L'éditeur d'appel doit être ouvert — appel sélectionné et déplié dans la
chronologie. Un bandeau indique la progression : bleu pendant l'exécution,
turquoise si tout est passé, rouge avec le nom de l'action fautive sinon.

### Gérer les combinaisons

Le panneau ⚙️ liste les combinaisons. Pour chacune :

- **l'œil** — affiche ou masque son bouton en bas de page. Masquer ne désactive
  pas le raccourci : l'œil ne gouverne que la barre. Seule la première est
  affichée au départ, et les combinaisons créées ensuite naissent masquées pour
  ne pas encombrer l'écran.
- **le nom**, éditable directement.
- **le raccourci** — cliquer sur le bouton le met en écoute : les modificateurs
  s'affichent au fur et à mesure que tu les enfonces (`Ctrl+…`), la combinaison
  est retenue dès que tu ajoutes une vraie touche. `Échap` annule. Un raccourci
  déjà attribué à une autre combinaison est refusé, avec le nom du coupable.
- **Absorber** — recopie dans la combinaison ce qui est *actuellement posé sur
  l'appel ouvert*.
- **Auto ASR** — désactivée par défaut. Une fois le ciblage de la chronologie
  établi : si l'appel précédent vise le même numéro et porte déjà cette
  combinaison, faire monter « Qualification du lead IA » d'un cran, plafonné à
  *Appel sans réponse 4*.

  Trois garde-fous, tous bloquants : sans numéro lisible des deux côtés,
  l'escalade ne se déclenche pas ; sans appel précédent, non plus ; et **une
  qualification déjà renseignée avec autre chose qu'un « appel sans réponse »
  est laissée intacte** — c'est le travail de l'opérateur, LazyQ ne l'écrase
  pas.
- **Supprimer**.

**+ Ajouter depuis l'appel courant** crée une combinaison à partir de l'appel
ouvert, nommée d'après les valeurs absorbées.

La façon la plus sûre de créer une combinaison : qualifier un appel à la main
comme tu veux la mémoriser, puis absorber. Ça évite de retaper des libellés
exacts — « Call Commercial : prospection », avec ses espaces autour du
deux-points, est précisément le genre de chaîne qu'on saisit mal. L'absorption
ignore les champs vides : le texte « Sélectionner » n'est pas une valeur.

Une touche nue est refusée comme raccourci : sans `Ctrl`, `Alt` ou `Cmd`, tu la
déclencherais en tapant une note. Le raccourci par défaut utilise `Ctrl` même sur
macOS, `Cmd+Maj+K` étant déjà pris par la console de Firefox.

Tout est mémorisé dans le `localStorage` du navigateur
(`lazyQ.presets.v1`). Les enregistrements des versions antérieures, sous
`hsQuickCall.*`, sont repris automatiquement.

## Comment ça marche

### L'app HubSpot est un empilement d'iframes

C'est le point qui gouverne l'architecture. La fiche contact
(`/contacts/.../record/...`) et le widget d'appel (`/calling/.../twilio`, app
`calling-widget-ui`) sont des **documents séparés**. Un script qui ne regarde
qu'un seul `document` ne voit donc pas forcément les champs.

Le script est injecté dans chaque frame — d'où `all_frames` dans le manifeste.
Celle qui contient les champs de la combinaison se déclare et exécute ; les
autres restent passives. Le pilotage vit dans la frame principale et communique
par `postMessage`. Le raccourci est écouté partout, puisque le focus peut être
dans le widget d'appel, et l'absorption fait un aller-retour : la frame porteuse
répond avec ce qu'elle lit.

### Le ciblage se fait par libellé visible

Les classes CSS de l'app HubSpot sont obfusquées et changent à chaque
déploiement, alors que « Résultat de l'appel » reste « Résultat de l'appel ». Le
script remonte du libellé vers le déclencheur du menu, clique (séquence
`pointerdown`/`mousedown`/`click` complète — certains composants n'écoutent pas
`click`), puis cherche l'option. La comparaison ignore la casse, les accents et
l'espacement autour des `:`.

### Comment une option est identifiée

La page contient en permanence des dizaines d'éléments qui ressemblent à des
options : la navigation latérale (`[class*="menu"] li`), les listes de propriétés
(`[data-test-id*="option"]` — un champ nommé `options_co_logiciel_ia` matche).
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
rouvert, ce qui rend l'action idempotente.

## Quand ça casse

Le ciblage repose sur la structure du DOM de HubSpot. Le jour où elle bouge, la
sonde dit quoi corriger. Elle n'a volontairement ni bouton ni raccourci : c'est
un outil de diagnostic, pas un geste quotidien.

1. Ouvrir l'éditeur d'appel, puis dans la console : `lazyQ.probe()`.
2. La sonde interroge toutes les frames et ouvre un panneau avec le rapport
   déjà sélectionné — `Cmd+C` suffit. Il liste, frame par frame : les libellés
   candidats, le déclencheur retenu pour chaque champ, sa valeur actuelle, les
   menus visibles avec leurs `data-test-id`.
3. Corriger `CONFIG.fields[].labels` si un libellé a changé.

Le rapport n'est pas copié automatiquement : `navigator.clipboard` exige une
activation utilisateur transitoire, or la collecte inter-frames est asynchrone —
au moment de copier, le geste a expiré et l'appel est rejeté. Le bouton *Copier*
du panneau, lui, s'exécute dans un vrai handler de clic et fonctionne.

Le rapport est aussi imprimé dans la console et disponible dans
`window.__lazyQProbe`.

Pour tester une action isolément :

```js
await lazyQ.selectValue(lazyQ.actionsFor(lazyQ.presets[0])[0]);
lazyQ.findTrigger(["résultat de l'appel"]);
lazyQ.readCurrentValues();
```

## Configuration du code

Au quotidien tu n'as pas à toucher au fichier : les combinaisons se gèrent depuis
⚙️. L'objet `CONFIG` en tête du userscript reste utile pour :

| Clé | Rôle |
| --- | --- |
| `fields` | Champs que le script sait lire et remplir (`name` + `labels`) |
| `defaultPresets` | Combinaisons livrées, au premier lancement seulement |
| `autoSave` | Clique *Enregistrer* après les actions. `false` par défaut |
| `showButtons` | Affiche la barre de boutons |
| `buttonOpacity` | Opacité des boutons au repos (`0.9`), pleine au survol |
| `timeoutMs` | Attente max pour l'apparition d'un champ ou d'une option |

`fields` n'est à modifier que pour apprendre au script un **nouveau champ**,
au-delà du type et du résultat d'appel.

## Développement

```
npm install
npm run build    # régénère extension/ depuis le userscript
npm run icons    # régénère les icônes (python3, sans dépendance)
npm test
```

Le userscript est la source unique ; `extension/content.js`,
`extension/manifest.json` et `docs/installation.html` en sont dérivés, et un test
échoue s'ils ne sont plus à jour — la notice embarquant le script, une version
périmée s'y installerait sans bruit. Le manifeste injecte le script en `world: "MAIN"`, donc dans le même
contexte qu'un userscript : `window.lazyQ` reste accessible depuis la console
ordinaire, et le comportement est identique à la version validée.

`npm test` couvre trois choses :

- **`editor.test.mjs`** — le script contre un DOM simulé (jsdom) reproduisant
  l'éditeur d'appel et le bruit permanent de la page : navigation et spans
  `role="option"` portant le texte cherché.
- **`migration.test.mjs`** — la reprise des combinaisons enregistrées sous
  l'ancien nom, et la résistance à un stockage corrompu.
- **`extension.test.mjs`** — la fraîcheur de l'extension et de la notice, et la
  cohérence du manifeste.

Ces harnais valident la mécanique, **pas** que les sélecteurs correspondent au
vrai DOM HubSpot : seule la sonde sur le portail réel le dit.

## Limites

- **Fragile par nature** : dépend du DOM de l'app HubSpot, qui change sans
  préavis. La sonde est là pour ça.
- **Les combinaisons sont locales au navigateur** : elles ne suivent ni le
  profil HubSpot ni les autres postes.
- **Le déclencheur de chaque champ est un `<button>` sans `data-test-id`**,
  identifié uniquement par sa position sous le libellé. C'est le point le plus
  fragile du montage.
- **La sauvegarde reste manuelle** tant que `autoSave` est sur `false`.
- **Pas de garde-fou sur l'appel visé** : le script agit sur le premier éditeur
  visible portant les champs attendus.

## Suite

Le portage naturel est une **UI extension** HubSpot
(`@hubspot/ui-extensions`) : un bouton natif sur la fiche contact appelant une
serverless function qui écrit `hs_activity_type` et `hs_call_disposition` via
l'API CRM v3. Plus de dépendance au DOM, et des combinaisons partageables à
l'équipe. Nécessite Sales Hub ou Service Hub Enterprise.

Attention : `hs_call_disposition` attend un **GUID**, pas un libellé. Il faudra
récupérer l'identifiant réel de « Répondeur/Pas de réponse » dans le portail, les
valeurs par défaut de HubSpot ne couvrant pas les dispositions personnalisées.

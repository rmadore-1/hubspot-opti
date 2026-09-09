import { JSDOM } from 'jsdom';
import fs from 'fs';

const script = fs.readFileSync(new URL('../userscript/hubspot-quick-call-log.user.js', import.meta.url), 'utf8');

// Approximation de l'éditeur d'appel HubSpot : libellé + bouton déclencheur,
// menu rendu dans un portail attaché au body. On reproduit aussi le bruit
// permanent constaté sur le vrai portail — navigation et affichage des valeurs
// courantes portent des sélecteurs qui ressemblent à des options.
const HTML = `<!doctype html><html><body>
  <nav class="nav-menu">
    <ul><li>Répondeur/Pas de réponse</li><li>Call Commercial : prospection</li></ul>
  </nav>
  <div class="property-list">
    <span data-test-id="options_co_logiciel_ia">Options - co logiciel IA</span>
    <span role="option">Call Commercial : prospection</span>
    <span role="option">Répondeur/Pas de réponse</span>
  </div>
  <div class="editor">
    <div class="field">
      <label>Type d'appel</label>
      <div class="private-select">
        <button aria-haspopup="listbox" data-test-id="call-type-select">Sélectionner</button>
      </div>
    </div>
    <div class="field">
      <label>Résultat de l'appel</label>
      <div class="private-select">
        <button aria-haspopup="listbox" data-test-id="call-outcome-select">Sélectionner</button>
      </div>
    </div>
    <button class="save">Enregistrer</button>
  </div>
</body></html>`;

const OPTIONS = {
  'call-type-select': ['Call Commercial : prospection', 'Call Commercial : relance', 'Call support'],
  'call-outcome-select': ['Connecté', 'Répondeur/Pas de réponse', 'Numéro erroné', 'Occupé'],
};

const dom = new JSDOM(HTML, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  // localStorage exige une origine : sans url, jsdom ne l'expose pas.
  url: 'https://app-eu1.hubspot.com/contacts/145766737/record/0-1/828923682002',
});
const { window } = dom;

// jsdom ne fait pas de layout : on rend tout "visible" sauf display:none.
window.Element.prototype.getClientRects = function () {
  return window.getComputedStyle(this).display === 'none' ? [] : [{ width: 100, height: 20 }];
};
window.Element.prototype.scrollIntoView = function () {};

// Câblage des menus : mousedown bascule un listbox en portail, clic sur une
// option écrit la valeur dans le déclencheur et referme — comme HubSpot.
for (const [testId, values] of Object.entries(OPTIONS)) {
  const trigger = window.document.querySelector(`[data-test-id="${testId}"]`);
  trigger.addEventListener('mousedown', () => {
    const open = window.document.querySelector('[role="listbox"]');
    if (open) { open.remove(); return; }
    const listbox = window.document.createElement('ul');
    listbox.setAttribute('role', 'listbox');
    for (const value of values) {
      const option = window.document.createElement('li');
      option.setAttribute('role', 'option');
      option.textContent = value;
      option.addEventListener('mousedown', () => {
        trigger.textContent = value;
        trigger.dataset.selected = value;
        listbox.remove();
      });
      listbox.appendChild(option);
    }
    window.document.body.appendChild(listbox);
  });
}

window.document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.document.querySelector('[role="listbox"]')?.remove();
});

window.eval(script);

const hs = window.hsQuickCall;
const results = [];
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail });
const el = (testId) => window.document.querySelector(`[data-test-id="${testId}"]`);
const reset = (testId) => { const t = el(testId); t.removeAttribute('data-selected'); t.textContent = 'Sélectionner'; };
const press = (init) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ...init }));
const release = (init) => window.document.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true, ...init }));

// 1. Détection des champs
check('trouve le déclencheur "Type d\'appel"',
  hs.findTrigger(["type d'appel"])?.trigger?.dataset.testId === 'call-type-select');
check('trouve le déclencheur "Résultat de l\'appel"',
  hs.findTrigger(["résultat de l'appel"])?.trigger?.dataset.testId === 'call-outcome-select');
check('reconnaît la frame qui porte les champs de la combinaison',
  hs.hasFieldsFor(hs.presets[0]));

// 2. Exécution d'une combinaison
await hs.runPreset(hs.presets[0]);
check('applique le type d\'appel',
  el('call-type-select').dataset.selected === 'Call Commercial : prospection',
  el('call-type-select').dataset.selected);
check('applique le résultat',
  el('call-outcome-select').dataset.selected === 'Répondeur/Pas de réponse',
  el('call-outcome-select').dataset.selected);
check('referme le menu après sélection', !window.document.querySelector('[role="listbox"]'));

// 3. Absorption des valeurs affichées
const absorbed = hs.readCurrentValues();
check('absorbe les deux valeurs posées sur l\'appel',
  absorbed["Type d'appel"] === 'Call Commercial : prospection'
  && absorbed["Résultat de l'appel"] === 'Répondeur/Pas de réponse',
  JSON.stringify(absorbed));

reset('call-outcome-select');
check('n\'absorbe pas le texte d\'un champ vide',
  hs.readCurrentValues()["Résultat de l'appel"] === undefined,
  JSON.stringify(hs.readCurrentValues()));

// 4. Tolérance casse / accents / espacement des deux-points
reset('call-type-select');
OPTIONS['call-type-select'][0] = 'Call commercial: PROSPECTION';
const loose = await hs.selectValue(hs.actionsFor(hs.presets[0])[0]);
check('matche malgré casse et espacement différents',
  loose.ok && el('call-type-select').dataset.selected === 'Call commercial: PROSPECTION',
  JSON.stringify(loose));

// 5. Échecs propres
const missing = await hs.selectValue({ name: 'Test', field: ["résultat de l'appel"], value: 'Valeur absente' });
check('échoue proprement sur une option absente',
  missing.ok === false && /option introuvable/.test(missing.why), missing.why);
const noField = await hs.selectValue({ name: 'Fantôme', field: ['champ inexistant'], value: 'x' });
check('échoue proprement sur un champ absent',
  noField.ok === false && /champ introuvable/.test(noField.why), noField.why);

// 6. Le bruit permanent de la page n'est jamais cliqué
reset('call-outcome-select');
const noise = await hs.selectValue(hs.actionsFor(hs.presets[0])[1]);
check('sélectionne la vraie option malgré des leurres au texte identique',
  noise.ok && el('call-outcome-select').dataset.selected === 'Répondeur/Pas de réponse',
  JSON.stringify(noise));
check('ne clique pas le span [role=option] qui affiche la valeur courante',
  window.document.querySelector('.property-list [role="option"]').isConnected);

// 7. Champ déjà rempli : on ne rouvre pas le menu
const already = await hs.selectValue(hs.actionsFor(hs.presets[0])[1]);
check('ne refait rien si la valeur est déjà bonne',
  already.ok && /déjà à la bonne valeur/.test(already.note || ''), JSON.stringify(already));

// 8. Un menu resté ouvert ne bloque pas
reset('call-type-select');
el('call-type-select').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
check('un menu est bien ouvert avant l\'appel', !!window.document.querySelector('[role="listbox"]'));
const reopened = await hs.selectValue(hs.actionsFor(hs.presets[0])[0]);
check('se rattrape quand le menu était déjà ouvert',
  reopened.ok && el('call-type-select').dataset.selected === 'Call commercial: PROSPECTION',
  JSON.stringify(reopened));

// 9. Sonde
const probe = hs.probeText();
check('la sonde nomme les deux champs',
  probe.includes("Type d'appel") && probe.includes("Résultat de l'appel"));
check('la sonde liste les menus détectés', /Menus visibles \(2\)/.test(probe));
check('la sonde annonce les candidats bruts sans les confondre avec un menu ouvert',
  /Candidats « option » présents sur la page \(2\)/.test(probe),
  probe.split('\n').find((l) => l.startsWith('Candidats')));
check('la sonde affiche la valeur actuelle du champ',
  probe.includes('valeur actuelle = "Call commercial: PROSPECTION"'));

// 10. Enregistrement d'un raccourci, avec retour visuel
check('décrit le raccourci lisiblement',
  hs.describeHotkey({ key: 'k', ctrlKey: true, shiftKey: true }) === 'Ctrl+Maj+K',
  hs.describeHotkey({ key: 'k', ctrlKey: true, shiftKey: true }));
check('ne matche pas si un modificateur diffère',
  !hs.matchesHotkey({ key: 'k', ctrlKey: true, shiftKey: true, altKey: false, metaKey: true },
    { key: 'k', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }));

let live = [];
let done = 'pas appelé';
hs.recordHotkey((text) => live.push(text), (next) => { done = next; });
press({ key: 'Control', ctrlKey: true });
check('affiche les modificateurs enfoncés en direct',
  live.includes('Ctrl+…'), JSON.stringify(live));
release({ key: 'Control' });
press({ key: 'p' });
check('refuse une touche sans modificateur',
  done === 'pas appelé' && live.includes('Ajoute Ctrl, Alt ou Cmd'), JSON.stringify(live));
press({ key: 'M', ctrlKey: true, altKey: true });
check('retient la combinaison complète',
  done && done.key === 'm' && done.ctrlKey && done.altKey, JSON.stringify(done));

done = 'pas appelé';
hs.recordHotkey(() => {}, (next) => { done = next; });
press({ key: 'Escape' });
check('Échap annule sans rien changer', done === null, JSON.stringify(done));

// 11. Persistance des combinaisons
hs.presets[0].hotkey = { key: 'm', ctrlKey: true, shiftKey: false, altKey: true, metaKey: false };
hs.savePresets();
const stored = JSON.parse(window.localStorage.getItem('hsQuickCall.presets.v1'));
check('mémorise les combinaisons pour la prochaine visite',
  stored[0].hotkey.key === 'm' && stored[0].values["Type d'appel"], JSON.stringify(stored[0].hotkey));

// 12. Visibilité des boutons : masqué par défaut sauf le premier
const barButtons = () => [...window.document.getElementById('hs-quick-call-ui').children];
check('la barre montre la combinaison visible et le bouton réglages',
  barButtons().length === 2 && barButtons()[0].textContent === 'Répondeur / Prospection',
  barButtons().map((b) => b.textContent).join(' | '));

hs.presets.push({ id: 'second', label: 'Connecté / Relance', hotkey: null, visible: false, values: { "Type d'appel": 'Call Commercial : relance' } });
hs.savePresets();
check('une combinaison masquée n\'ajoute pas de bouton',
  barButtons().length === 2, barButtons().map((b) => b.textContent).join(' | '));

hs.setPresetVisible(hs.presets[1], true);
check('l\'oeil fait apparaître son bouton',
  barButtons().length === 3 && barButtons()[1].textContent === 'Connecté / Relance',
  barButtons().map((b) => b.textContent).join(' | '));

hs.setPresetVisible(hs.presets[0], false);
check('l\'oeil retire le bouton sans supprimer la combinaison',
  barButtons().length === 2 && hs.presets.length === 2,
  barButtons().map((b) => b.textContent).join(' | '));

check('les boutons sont atténués au repos',
  barButtons().every((b) => Number(b.style.opacity) === hs.CONFIG.buttonOpacity),
  barButtons().map((b) => b.style.opacity).join(' | '));
barButtons()[0].dispatchEvent(new window.MouseEvent('mouseenter'));
check('le survol les rend pleins', barButtons()[0].style.opacity === '1');

// 13. L'oeil est un tracé, pas un emoji : aucune dépendance à la police
hs.toggleSettings();
const eyes = () => [...window.document.querySelectorAll('[title^="Afficher ou masquer"]')];
check('le panneau expose un oeil par combinaison', eyes().length === hs.presets.length,
  String(eyes().length));
check('l\'oeil est dessiné en SVG et non écrit en texte',
  eyes().every((b) => b.querySelector('svg') && !b.textContent.trim()),
  eyes().map((b) => JSON.stringify(b.textContent)).join(' | '));

// presets[0] est masqué, presets[1] visible depuis les tests précédents
const pathCount = (b) => b.querySelectorAll('path').length;
check('l\'oeil barré porte un trait de plus que l\'oeil ouvert',
  pathCount(eyes()[0]) === pathCount(eyes()[1]) + 1,
  `${pathCount(eyes()[0])} vs ${pathCount(eyes()[1])}`);

eyes()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('cliquer l\'oeil rétablit le bouton et l\'icône ouverte',
  hs.presets[0].visible && pathCount(eyes()[0]) === 2 && barButtons().length === 3,
  `${hs.presets[0].visible} / ${pathCount(eyes()[0])} / ${barButtons().length}`);

check('les boutons sont un peu moins transparents', hs.CONFIG.buttonOpacity >= 0.85);

console.log('\n--- RÉSULTATS ---');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} tests passés`);
process.exit(failed ? 1 : 0);

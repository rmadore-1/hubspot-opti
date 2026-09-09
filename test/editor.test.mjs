import { JSDOM } from 'jsdom';
import fs from 'fs';

const script = fs.readFileSync(new URL('../userscript/hubspot-quick-call-log.user.js', import.meta.url), 'utf8');

// Approximation de l'éditeur d'appel HubSpot : libellé + bouton déclencheur,
// menu rendu dans un portail attaché au body à l'ouverture.
const HTML = `<!doctype html><html><body>
  <nav class="nav-menu">
    <ul><li>Répondeur/Pas de réponse</li><li>Call Commercial : prospection</li></ul>
  </nav>
  <div class="property-list">
    <span data-test-id="options_co_logiciel_ia">Options - co logiciel IA</span>
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

const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// jsdom ne fait pas de layout : on rend tout "visible" sauf display:none.
window.Element.prototype.getClientRects = function () {
  return window.getComputedStyle(this).display === 'none' ? [] : [{ width: 100, height: 20 }];
};
window.Element.prototype.scrollIntoView = function () {};

// Câblage des menus : mousedown ouvre un listbox en portail, clic sur une option
// écrit la valeur dans le déclencheur et referme — comme le composant HubSpot.
for (const [testId, values] of Object.entries(OPTIONS)) {
  const trigger = window.document.querySelector(`[data-test-id="${testId}"]`);
  trigger.addEventListener('mousedown', () => {
    if (window.document.querySelector('[role="listbox"]')) return;
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

// Le composant réel se referme sur Escape : sans ça, un menu resté ouvert
// fausse les tests suivants.
window.document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.document.querySelector('[role="listbox"]')?.remove();
});

window.eval(script);

const results = [];
const check = (name, condition, detail = '') =>
  results.push({ name, ok: !!condition, detail });

// 1. Détection des champs
const typeTrigger = window.hsQuickCall.findTrigger(["type d'appel"]);
const outcomeTrigger = window.hsQuickCall.findTrigger(["résultat de l'appel"]);
check('trouve le déclencheur "Type d\'appel"',
  typeTrigger?.trigger?.dataset.testId === 'call-type-select',
  typeTrigger?.trigger?.outerHTML.slice(0, 60));
check('trouve le déclencheur "Résultat de l\'appel"',
  outcomeTrigger?.trigger?.dataset.testId === 'call-outcome-select',
  outcomeTrigger?.trigger?.outerHTML.slice(0, 60));
check('hasAllFields() vrai quand les deux champs sont là', window.hsQuickCall.hasAllFields());

// 2. Exécution complète
await window.hsQuickCall.run();
const typeValue = window.document.querySelector('[data-test-id="call-type-select"]').dataset.selected;
const outcomeValue = window.document.querySelector('[data-test-id="call-outcome-select"]').dataset.selected;
check('sélectionne le type d\'appel', typeValue === 'Call Commercial : prospection', `→ ${typeValue}`);
check('sélectionne le résultat', outcomeValue === 'Répondeur/Pas de réponse', `→ ${outcomeValue}`);
check('referme le menu après sélection', !window.document.querySelector('[role="listbox"]'));

// 3. Tolérance sur la casse / les accents / l'espacement des deux-points
window.document.querySelector('[data-test-id="call-type-select"]').removeAttribute('data-selected');
OPTIONS['call-type-select'][0] = 'Call commercial: PROSPECTION';
window.document.querySelector('[data-test-id="call-type-select"]').textContent = 'Sélectionner';
const loose = await window.hsQuickCall.selectValue(window.hsQuickCall.CONFIG.actions[0]);
check('matche malgré casse et espacement différents',
  loose.ok && window.document.querySelector('[data-test-id="call-type-select"]').dataset.selected === 'Call commercial: PROSPECTION',
  JSON.stringify(loose));

// 4. Échec propre quand l'option n'existe pas
const missing = await window.hsQuickCall.selectValue({
  name: 'Test', field: ["résultat de l'appel"], value: 'Valeur qui n\'existe pas',
});
check('échoue proprement sur une option absente',
  missing.ok === false && /option introuvable/.test(missing.why), missing.why);

// 5. Échec propre quand le champ n'existe pas
const noField = await window.hsQuickCall.selectValue({
  name: 'Fantôme', field: ['champ inexistant'], value: 'x',
});
check('échoue proprement sur un champ absent',
  noField.ok === false && /champ introuvable/.test(noField.why), noField.why);

// 6. La sonde produit un rapport lisible
const probe = window.hsQuickCall.probeText();
check('la sonde nomme les deux champs',
  probe.includes("Type d'appel") && probe.includes("Résultat de l'appel"));
check('la sonde liste les menus détectés', /Menus visibles \(2\)/.test(probe));
check('la sonde ne compte pas la navigation comme des options ouvertes',
  /Options actuellement ouvertes \(0\)/.test(probe),
  probe.split('\n').find((l) => l.startsWith('Options')));
check('la sonde affiche la valeur actuelle du champ',
  probe.includes('valeur actuelle = "Call commercial: PROSPECTION"'));

// 7. Le bruit permanent de la page n'est jamais cliqué
const outcome = window.document.querySelector('[data-test-id="call-outcome-select"]');
outcome.removeAttribute('data-selected');
outcome.textContent = 'Sélectionner';
const noise = await window.hsQuickCall.selectValue(window.hsQuickCall.CONFIG.actions[1]);
check('sélectionne la vraie option malgré un <li> de nav au texte identique',
  noise.ok && outcome.dataset.selected === 'Répondeur/Pas de réponse',
  JSON.stringify(noise));

// 8. Champ déjà rempli : on ne rouvre pas le menu
const already = await window.hsQuickCall.selectValue(window.hsQuickCall.CONFIG.actions[1]);
check('ne refait rien si la valeur est déjà bonne',
  already.ok && /déjà à la bonne valeur/.test(already.note || ''), JSON.stringify(already));

console.log('\n--- RÉSULTATS ---');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} tests passés`);
console.log('\n--- EXTRAIT DE SONDE ---\n' + probe.split('\n').slice(0, 12).join('\n'));
process.exit(failed ? 1 : 0);

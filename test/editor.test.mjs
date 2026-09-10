import { JSDOM } from 'jsdom';
import fs from 'fs';

const script = fs.readFileSync(new URL('../userscript/lazyq.user.js', import.meta.url), 'utf8');

// Le DOM reproduit la structure relevée sur le portail :
//  - chaque activité porte [data-test-id="timeline-preview-event"], niché dans
//    un bloc d'accordéon qui contient aussi l'éditeur déplié ;
//  - l'aperçu replié n'affiche que le résultat de l'appel, pas son type ;
//  - « Qualification du lead IA » est une propriété différée de la barre
//    latérale : lecture seule jusqu'au clic ;
//  - la page porte en permanence des leurres qui ressemblent à des options.
function callCard({ id, outcome, phone, date, open }) {
  return `
  <div class="accordion" data-item="${id}">
    <span role="presentation">
      <button class="toggle" aria-expanded="false" aria-label="Développer"></button>
      <div class="flex">
        <div data-test-id="timeline-preview-event">
          <h4><span data-test-id="generic-preview-event-header"><span data-content="true"><span>Appel - ${outcome} passé par Aurélien Milano</span></span></span></h4>
        </div>
        <div class="with">avec ${phone}</div>
        <div class="when">${date}</div>
      </div>
    </span>
    <div class="body">${open ? EDITOR : ''}</div>
  </div>`;
}

const EDITOR = `
  <div class="field">
    <label>Type d'appel</label>
    <div class="private-select"><button aria-haspopup="listbox" data-test-id="call-type-select">Sélectionner</button></div>
  </div>
  <div class="field">
    <label>Résultat de l'appel</label>
    <div class="private-select"><button aria-haspopup="listbox" data-test-id="call-outcome-select">Sélectionner</button></div>
  </div>
  <button class="save">Enregistrer</button>`;

const HTML = `<!doctype html><html><body>
  <nav class="nav-menu">
    <ul><li>Répondeur/Pas de réponse</li><li>Call Commercial : prospection</li></ul>
  </nav>

  <aside class="sidebar">
    <div class="View" data-deferred-property-input-root="true" data-deferred-property-input-state="editable" data-deferred-property-input-mode="display" role="button">
      <div class="FormControl__LabelWrapper"><label id="FormControl-label145"><span><span>Qualification du lead IA</span></span></label></div>
      <div class="value">Essai IA</div>
    </div>
    <span data-test-id="options_co_logiciel_ia">Options - co logiciel IA</span>
    <span role="option">Call Commercial : prospection</span>
    <span role="option">Répondeur/Pas de réponse</span>
  </aside>

  <section class="timeline">
    ${callCard({ id: 1, outcome: 'Connecté', phone: '+33 5 58 83 87 63', date: '10 sept. 2026 à 11:53 GMT+2', open: false })}
    ${callCard({ id: 2, outcome: 'Répondeur/Pas de réponse', phone: '05 58 83 87 63', date: '9 sept. 2026 à 09:20 GMT+2', open: false })}
    ${callCard({ id: 3, outcome: 'Connecté', phone: '06 99 88 77 66', date: '1 sept. 2026 à 15:04 GMT+2', open: false })}
  </section>
</body></html>`;

const OPTIONS = {
  'call-type-select': ['Call Commercial : prospection', 'Call Commercial : relance', 'Call support'],
  'call-outcome-select': ['Connecté', 'Répondeur/Pas de réponse', 'Numéro erroné', 'Occupé'],
  'asr-select': ['Essai IA', 'Appel sans réponse 1', 'Appel sans réponse 2', 'Appel sans réponse 3', 'Appel sans réponse 4', 'Rendez-vous pris'],
};

const dom = new JSDOM(HTML, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://app-eu1.hubspot.com/contacts/145766737/record/0-1/828923682002',
});
const { window } = dom;
const doc = window.document;

// jsdom ne fait pas de layout : on rend tout "visible" sauf display:none.
window.Element.prototype.getClientRects = function () {
  return window.getComputedStyle(this).display === 'none' ? [] : [{ width: 100, height: 20 }];
};
window.Element.prototype.scrollIntoView = function () {};

/** Menu HubSpot : bascule à chaque mousedown, options en portail sur le body. */
function wireSelect(trigger, values) {
  if (trigger.dataset.wired) return;
  trigger.dataset.wired = '1';
  trigger.addEventListener('mousedown', () => {
    const open = doc.querySelector('[role="listbox"]');
    if (open) { open.remove(); return; }
    const listbox = doc.createElement('ul');
    listbox.setAttribute('role', 'listbox');
    for (const value of values) {
      const option = doc.createElement('li');
      option.setAttribute('role', 'option');
      option.textContent = value;
      option.addEventListener('mousedown', () => {
        trigger.textContent = value;
        trigger.dataset.selected = value;
        listbox.remove();
      });
      listbox.appendChild(option);
    }
    doc.body.appendChild(listbox);
  });
}

/** Déplie un accordéon au clic sur son en-tête, comme le composant réel. */
for (const accordion of doc.querySelectorAll('.accordion')) {
  accordion.querySelector('.toggle').addEventListener('mousedown', (event) => {
    const body = accordion.querySelector('.body');
    const opening = !body.innerHTML.trim();
    body.innerHTML = opening ? EDITOR : '';
    event.currentTarget.setAttribute('aria-expanded', String(opening));
    for (const [testId, values] of Object.entries(OPTIONS)) {
      const trigger = body.querySelector(`[data-test-id="${testId}"]`);
      if (trigger) wireSelect(trigger, values);
    }
  });
}

/** Propriété différée : le clic la fait passer en édition et révèle un menu. */
const property = doc.querySelector('[data-deferred-property-input-root]');
property.addEventListener('mousedown', () => {
  if (property.getAttribute('data-deferred-property-input-mode') === 'edit') return;
  property.setAttribute('data-deferred-property-input-mode', 'edit');
  const value = property.querySelector('.value');
  const trigger = doc.createElement('button');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.dataset.testId = 'asr-select';
  trigger.textContent = value.textContent;
  value.replaceWith(trigger);
  wireSelect(trigger, OPTIONS['asr-select']);
});

doc.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') doc.querySelector('[role="listbox"]')?.remove();
});

window.eval(script);

const hs = window.lazyQ;
const results = [];
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail });
const el = (testId) => doc.querySelector(`[data-test-id="${testId}"]`);
const press = (init) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ...init }));
const release = (init) => doc.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true, ...init }));
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// 1. Chronologie
// ---------------------------------------------------------------------------
const cards = hs.findCallCards();
check('repère les trois appels de la chronologie', cards.length === 3, String(cards.length));
check('remonte jusqu\'au bloc qui porte aussi l\'éditeur',
  cards[0].classList.contains('accordion'), cards[0]?.className);
check('n\'englobe jamais deux appels dans une carte',
  cards.every((card) => card.querySelectorAll('[data-test-id="timeline-preview-event"]').length === 1));
check('classe par date, le plus récent d\'abord',
  cards.map((c) => c.dataset.item).join(',') === '1,2,3',
  cards.map((c) => c.dataset.item).join(','));

const [last, previous, older] = cards.map(hs.cardInfo);
check('lit la date de la carte',
  new Date(hs.cardDate(last.text)).toISOString().startsWith('2026-09-10T11:53'),
  String(hs.cardDate(last.text)));
check('extrait le numéro malgré les formats différents',
  last.phones[0] === '558838763' && previous.phones[0] === '558838763',
  JSON.stringify([last.phones, previous.phones]));
check('ne prend pas la date pour un numéro', last.phones.length === 1, JSON.stringify(last.phones));
check('n\'aspire pas le jour de la date dans le numéro',
  last.phones[0] === '558838763', last.phones[0]);
check('extrait le numéro même collé à une date sans séparateur net',
  hs.phonesIn('avec +33 5 58 83 87 63 10 sept. 2026 à 11:53 GMT+2')[0] === '558838763',
  JSON.stringify(hs.phonesIn('avec +33 5 58 83 87 63 10 sept. 2026 à 11:53 GMT+2')));
check('reconnaît deux appels au même numéro', hs.samePhone(last, previous));
check('distingue un numéro différent', !hs.samePhone(last, older));

// L'aperçu replié ne montre que le résultat : une seule valeur suffit à trancher.
check('reconnaît un appel précédent catégorisé comme la combinaison',
  hs.cardMatchesPreset(previous, hs.presets[0]));
check('ne confond pas avec un appel connecté',
  !hs.cardMatchesPreset(older, hs.presets[0]));

// ---------------------------------------------------------------------------
// 2. Exécution complète sur le dernier appel
// ---------------------------------------------------------------------------
check('aucun appel n\'est déplié au départ',
  !hs.cardIsOpen(cards[0], hs.presets[0]));

await hs.runPreset(hs.presets[0]);
await settle();

check('déplie le dernier appel', doc.querySelector('.accordion[data-item="1"] .body').innerHTML.trim() !== '');
check('applique le type d\'appel au dernier appel',
  el('call-type-select').dataset.selected === 'Call Commercial : prospection',
  el('call-type-select')?.dataset.selected);
check('applique le résultat au dernier appel',
  el('call-outcome-select').dataset.selected === 'Répondeur/Pas de réponse',
  el('call-outcome-select')?.dataset.selected);
check('laisse les autres appels repliés',
  doc.querySelector('.accordion[data-item="2"] .body').innerHTML.trim() === '');
check('Auto ASR étant décochée, la qualification est intacte',
  doc.querySelector('[data-deferred-property-input-root]').textContent.includes('Essai IA'));

// ---------------------------------------------------------------------------
// 3. Champs et options
// ---------------------------------------------------------------------------
check('trouve le déclencheur "Type d\'appel"',
  hs.findTrigger(["type d'appel"])?.trigger?.dataset.testId === 'call-type-select');
check('ne clique pas le span [role=option] qui affiche la valeur courante',
  doc.querySelector('.sidebar [role="option"]').isConnected);

const already = await hs.selectValue(hs.actionsFor(hs.presets[0])[1]);
check('ne refait rien si la valeur est déjà bonne',
  already.ok && /déjà à la bonne valeur/.test(already.note || ''), JSON.stringify(already));

const missing = await hs.selectValue({ name: 'Test', field: ["résultat de l'appel"], value: 'Valeur absente' });
check('échoue proprement sur une option absente',
  missing.ok === false && /option introuvable/.test(missing.why), missing.why);
const noField = await hs.selectValue({ name: 'Fantôme', field: ['champ inexistant'], value: 'x' });
check('échoue proprement sur un champ absent',
  noField.ok === false && /champ introuvable/.test(noField.why), noField.why);

// ---------------------------------------------------------------------------
// 4. Propriété différée de la barre latérale
// ---------------------------------------------------------------------------
const control = hs.findPropertyControl(hs.CONFIG.asrField.labels);
check('trouve la propriété différée par son libellé',
  control === doc.querySelector('[data-deferred-property-input-root]'));
check('lit sa valeur sans le libellé',
  hs.readPropertyValue(control) === 'Essai IA', hs.readPropertyValue(control));

// ---------------------------------------------------------------------------
// 5. Escalade
// ---------------------------------------------------------------------------
check('chaîné depuis une qualification vide donne 2', hs.asrTarget('', true) === 'Appel sans réponse 2');
check('chaîné depuis la valeur sans numéro donne 2', hs.asrTarget('Appel sans réponse', true) === 'Appel sans réponse 2');
check('chaîné escalade 2 vers 3', hs.asrTarget('Appel sans réponse 2', true) === 'Appel sans réponse 3');
check('chaîné escalade 3 vers 4', hs.asrTarget('Appel sans réponse 3', true) === 'Appel sans réponse 4');
check('chaîné plafonne à 4', hs.asrTarget('Appel sans réponse 4', true) === 'Appel sans réponse 4');
check('non chaîné pose le cran 1', hs.asrTarget('', false) === 'Appel sans réponse 1');
check('non chaîné ramène un cran existant à 1', hs.asrTarget('Appel sans réponse 3', false) === 'Appel sans réponse 1');
check('écrase une qualification étrangère au lieu de s\'abstenir',
  hs.asrTarget('Essai IA', false) === 'Appel sans réponse 1'
  && hs.asrTarget('Rendez-vous pris', true) === 'Appel sans réponse 2',
  `${hs.asrTarget('Essai IA', false)} / ${hs.asrTarget('Rendez-vous pris', true)}`);

// « Essai IA » est écrasé : la propriété passe en édition et prend le cran.
hs.setPresetAutoASR(hs.presets[0], true);
const overwritten = await hs.applyAutoASR(false);
await settle();
check('Auto ASR écrase Essai IA par le cran 1',
  el('asr-select')?.dataset.selected === 'Appel sans réponse 1',
  JSON.stringify(overwritten) + ' / ' + el('asr-select')?.dataset.selected);

const chainedRun = await hs.applyAutoASR(true);
await settle();
check('Auto ASR chaîné monte ensuite au cran 2',
  el('asr-select')?.dataset.selected === 'Appel sans réponse 2',
  JSON.stringify(chainedRun) + ' / ' + el('asr-select')?.dataset.selected);
check('la propriété est passée en mode édition',
  doc.querySelector('[data-deferred-property-input-root]').getAttribute('data-deferred-property-input-mode') === 'edit');

const nextRun = await hs.applyAutoASR(true);
await settle();
check('un second passage chaîné monte à 3',
  el('asr-select')?.dataset.selected === 'Appel sans réponse 3',
  JSON.stringify(nextRun) + ' / ' + el('asr-select')?.dataset.selected);

const aloneRun = await hs.applyAutoASR(false);
await settle();
check('un passage non chaîné redescend au cran 1',
  el('asr-select')?.dataset.selected === 'Appel sans réponse 1',
  JSON.stringify(aloneRun) + ' / ' + el('asr-select')?.dataset.selected);
hs.setPresetAutoASR(hs.presets[0], false);

// ---------------------------------------------------------------------------
// 6. Sonde
// ---------------------------------------------------------------------------
const probe = hs.probeText();
check('la sonde nomme les champs et la propriété',
  probe.includes("Type d'appel") && probe.includes('Qualification du lead IA'));
check('la sonde compte les événements de la chronologie',
  /Ancre \[data-test-id="timeline-preview-event"\] — 3 événement\(s\)/.test(probe),
  probe.split('\n').find((l) => l.startsWith('Ancre')));
check('la sonde rapporte les cartes retenues', /Cartes d'appel retenues : 3/.test(probe));
check('la sonde annonce les candidats bruts sans les confondre avec un menu ouvert',
  /Candidats « option » présents sur la page \(2\)/.test(probe),
  probe.split('\n').find((l) => l.startsWith('Candidats')));

const anchorReport = hs.probeAnchor('passé par');
check('la sonde d\'ancre remonte les attributs utiles',
  anchorReport.includes('data-test-id="timeline-preview-event"'));
check('elle signale le niveau qui se répète',
  /div\.accordion[^\n]*niveau répété/.test(anchorReport),
  anchorReport.split('\n').find((l) => l.includes('accordion')) || '(aucune ligne accordion)');

// ---------------------------------------------------------------------------
// 7. Combinaisons, boutons, raccourcis
// ---------------------------------------------------------------------------
const barButtons = () => [...doc.getElementById('lazyq-bar').children];
check('la barre montre la combinaison visible et le bouton réglages',
  barButtons().length === 2 && barButtons()[0].textContent === 'Répondeur / Prospection',
  barButtons().map((b) => b.textContent).join(' | '));
check('les boutons sont atténués au repos',
  barButtons().every((b) => Number(b.style.opacity) === hs.CONFIG.buttonOpacity));
barButtons()[0].dispatchEvent(new window.MouseEvent('mouseenter'));
check('le survol les rend pleins', barButtons()[0].style.opacity === '1');

hs.presets.push({
  id: 'second', label: 'Connecté / Relance', hotkey: null, visible: false, autoASR: false,
  values: { "Type d'appel": 'Call Commercial : relance' },
});
hs.savePresets();
check('une combinaison masquée n\'ajoute pas de bouton', barButtons().length === 2);
hs.setPresetVisible(hs.presets[1], true);
check('l\'oeil fait apparaître son bouton', barButtons().length === 3);
hs.setPresetVisible(hs.presets[1], false);

hs.toggleSettings();
const eyes = () => [...doc.querySelectorAll('[title^="Afficher ou masquer"]')];
check('le panneau expose un oeil par combinaison', eyes().length === hs.presets.length);
check('l\'oeil est dessiné en SVG et non écrit en texte',
  eyes().every((b) => b.querySelector('svg') && !b.textContent.trim()));
check('l\'oeil barré porte un trait de plus que l\'oeil ouvert',
  eyes()[1].querySelectorAll('path').length === eyes()[0].querySelectorAll('path').length + 1,
  `${eyes()[1].querySelectorAll('path').length} vs ${eyes()[0].querySelectorAll('path').length}`);

const asrBoxes = () => [...doc.querySelectorAll('[title^="Si l\'appel précédent"] input')];
check('le panneau expose une case Auto ASR par combinaison', asrBoxes().length === hs.presets.length);
check('Auto ASR est décochée par défaut', asrBoxes().every((box, i) => box.checked === hs.presets[i].autoASR));
asrBoxes()[0].checked = true;
asrBoxes()[0].dispatchEvent(new window.Event('change', { bubbles: true }));
check('cocher la case active l\'option', hs.presets[0].autoASR === true);
check('l\'option est mémorisée',
  JSON.parse(window.localStorage.getItem('lazyQ.presets.v1'))[0].autoASR === true);
hs.setPresetAutoASR(hs.presets[0], false);

check('décrit le raccourci lisiblement',
  hs.describeHotkey({ key: 'k', ctrlKey: true, shiftKey: true }) === 'Ctrl+Maj+K');
check('ne matche pas si un modificateur diffère',
  !hs.matchesHotkey({ key: 'k', ctrlKey: true, shiftKey: true, altKey: false, metaKey: true },
    { key: 'k', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }));

let live = [];
let done = 'pas appelé';
hs.recordHotkey((text) => live.push(text), (next) => { done = next; });
press({ key: 'Control', ctrlKey: true });
check('affiche les modificateurs enfoncés en direct', live.includes('Ctrl+…'), JSON.stringify(live));
release({ key: 'Control' });
press({ key: 'p' });
check('refuse une touche sans modificateur',
  done === 'pas appelé' && live.includes('Ajoute Ctrl, Alt ou Cmd'));
press({ key: 'M', ctrlKey: true, altKey: true });
check('retient la combinaison complète', done && done.key === 'm' && done.ctrlKey && done.altKey);

done = 'pas appelé';
hs.recordHotkey(() => {}, (next) => { done = next; });
press({ key: 'Escape' });
check('Échap annule sans rien changer', done === null);

console.log('\n--- RÉSULTATS ---');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} tests passés`);
process.exit(failed ? 1 : 0);

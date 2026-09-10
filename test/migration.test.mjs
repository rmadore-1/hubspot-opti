// Les combinaisons enregistrées sous l'ancien nom doivent survivre au passage
// à LazyQ : c'est la seule chose que l'utilisateur perdrait sans reprise.
import { JSDOM } from 'jsdom';
import fs from 'fs';

const script = fs.readFileSync(new URL('../userscript/lazyq.user.js', import.meta.url), 'utf8');
const results = [];
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail });

function boot(seed) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://app-eu1.hubspot.com/contacts/1/record/0-1/2',
  });
  dom.window.Element.prototype.getClientRects = function () { return [{ width: 10, height: 10 }]; };
  for (const [key, value] of Object.entries(seed)) {
    dom.window.localStorage.setItem(key, JSON.stringify(value));
  }
  dom.window.eval(script);
  return dom.window;
}

// 1. Combinaisons de la version hsQuickCall, sans champ de visibilité
const legacy = boot({
  'hsQuickCall.presets.v1': [
    { id: 'a', label: 'Répondeur / Prospection', hotkey: { key: 'k', ctrlKey: true, shiftKey: true }, values: { "Type d'appel": 'Call Commercial : prospection' } },
    { id: 'b', label: 'Connecté / Relance', hotkey: null, values: { "Type d'appel": 'Call Commercial : relance' } },
  ],
});
check('reprend les combinaisons enregistrées sous l\'ancien nom',
  legacy.lazyQ.presets.length === 2 && legacy.lazyQ.presets[0].label === 'Répondeur / Prospection',
  JSON.stringify(legacy.lazyQ.presets.map((p) => p.label)));
check('conserve le raccourci de la première',
  legacy.lazyQ.presets[0].hotkey.key === 'k');
check('n\'active pas Auto ASR sur des combinaisons qui l\'ignoraient',
  legacy.lazyQ.presets.every((p) => p.autoASR === false),
  JSON.stringify(legacy.lazyQ.presets.map((p) => p.autoASR)));
check('affiche la première et masque les suivantes',
  legacy.lazyQ.presets[0].visible === true && legacy.lazyQ.presets[1].visible === false,
  JSON.stringify(legacy.lazyQ.presets.map((p) => p.visible)));

legacy.lazyQ.savePresets();
check('réécrit sous la nouvelle clé',
  JSON.parse(legacy.localStorage.getItem('lazyQ.presets.v1')).length === 2);

// 2. Raccourci unique des versions à une seule combinaison
const single = boot({ 'hsQuickCall.hotkey': { key: 'j', ctrlKey: true, altKey: true } });
check('reprend le raccourci unique des premières versions',
  single.lazyQ.presets[0].hotkey.key === 'j' && single.lazyQ.presets[0].hotkey.altKey,
  JSON.stringify(single.lazyQ.presets[0].hotkey));

// 3. Première installation
const fresh = boot({});
check('démarre sur la combinaison livrée',
  fresh.lazyQ.presets.length === 1 && fresh.lazyQ.presets[0].visible === true
  && fresh.lazyQ.presets[0].values["Résultat de l'appel"] === 'Répondeur/Pas de réponse');

// 4. Stockage illisible : on ne bloque pas le démarrage
const corrupt = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only', url: 'https://app-eu1.hubspot.com/contacts/1/record/0-1/2',
});
corrupt.window.Element.prototype.getClientRects = function () { return [{ width: 10, height: 10 }]; };
corrupt.window.localStorage.setItem('lazyQ.presets.v1', '{ pas du json');
corrupt.window.eval(script);
check('survit à un stockage corrompu', corrupt.window.lazyQ.presets.length === 1);

console.log('\n--- MIGRATION ---');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} tests passés`);
process.exit(failed ? 1 : 0);

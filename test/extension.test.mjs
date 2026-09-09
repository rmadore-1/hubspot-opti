// L'extension est générée depuis le userscript : ce test garantit qu'un
// changement du userscript non rebuildé ne passe pas inaperçu.
import fs from 'fs';
import { SOURCE, CONTENT, MANIFEST, buildContent, manifestText, buildManifest, readVersion } from '../scripts/build-extension.mjs';

const results = [];
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail });

const source = fs.readFileSync(SOURCE, 'utf8');
const version = readVersion(source);

check('extension/content.js est à jour',
  fs.readFileSync(CONTENT, 'utf8') === buildContent(source),
  'lance `npm run build`');
check('extension/manifest.json est à jour',
  fs.readFileSync(MANIFEST, 'utf8') === manifestText(source),
  'lance `npm run build`');

const manifest = buildManifest(source);
const contentScript = manifest.content_scripts[0];

check('le manifeste suit la version du userscript', manifest.version === version, manifest.version);
check('le script est injecté dans toutes les frames', contentScript.all_frames === true);
check('le script tourne dans le monde principal, comme le userscript',
  contentScript.world === 'MAIN');
check('les portails HubSpot EU sont couverts',
  contentScript.matches.includes('https://app-eu1.hubspot.com/*'));
check('aucune permission superflue n\'est demandée',
  manifest.permissions === undefined && manifest.host_permissions === undefined);
check('l\'extension porte le nom LazyQ', manifest.name === 'LazyQ');

const built = buildContent(source);
check('l\'en-tête Tampermonkey est retiré du build', !built.includes('==UserScript=='));
check('le corps du script est bien présent', built.includes('window.lazyQ ='));

for (const [size, file] of Object.entries(manifest.icons)) {
  const path = new URL(`../extension/${file}`, import.meta.url);
  const bytes = fs.existsSync(path) ? fs.readFileSync(path) : null;
  check(`l'icône ${size}px existe et est un PNG valide`,
    bytes && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && bytes.readUInt32BE(16) === Number(size));
}

console.log('\n--- EXTENSION ---');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} tests passés`);
process.exit(failed ? 1 : 0);

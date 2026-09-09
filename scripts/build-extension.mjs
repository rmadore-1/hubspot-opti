// Construit l'extension LazyQ à partir du userscript, qui reste la source
// unique. `npm run build` régénère extension/content.js et extension/manifest.json ;
// le harnais vérifie ensuite qu'ils sont à jour, pour qu'une modification du
// userscript ne puisse pas être oubliée côté extension.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SOURCE = path.join(ROOT, 'userscript', 'lazyq.user.js');
export const CONTENT = path.join(ROOT, 'extension', 'content.js');
export const MANIFEST = path.join(ROOT, 'extension', 'manifest.json');
export const DOC_TEMPLATE = path.join(ROOT, 'docs', 'installation.template.html');
export const DOC = path.join(ROOT, 'docs', 'installation.html');
export const ICON = path.join(ROOT, 'extension', 'icons', 'icon128.png');

const MATCHES = [
  'https://app.hubspot.com/*',
  'https://app-eu1.hubspot.com/*',
  'https://app-na1.hubspot.com/*',
];

export function readVersion(source) {
  const match = source.match(/^\/\/ @version\s+(\S+)/m);
  if (!match) throw new Error('@version introuvable dans le userscript');
  return match[1];
}

/** Retire l'en-tête Tampermonkey : l'extension le remplace par le manifeste. */
export function buildContent(source) {
  const body = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n*/, '');
  return [
    '// Généré par scripts/build-extension.mjs — ne pas modifier à la main.',
    `// Source : userscript/lazyq.user.js (v${readVersion(source)})`,
    '',
    body.trimStart(),
  ].join('\n');
}

export function buildManifest(source) {
  return {
    manifest_version: 3,
    name: 'LazyQ',
    version: readVersion(source),
    description: "Qualifie un appel HubSpot en un clic ou un raccourci clavier.",
    icons: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    content_scripts: [{
      matches: MATCHES,
      js: ['content.js'],
      run_at: 'document_idle',
      // L'éditeur d'appel vit dans une iframe : sans all_frames, le script ne
      // verrait jamais les champs.
      all_frames: true,
      // Monde principal, comme un userscript : même contexte d'exécution que la
      // version validée, et window.lazyQ reste accessible depuis la console.
      world: 'MAIN',
    }],
    browser_specific_settings: {
      gecko: { id: 'lazyq@webdentiste.eu', strict_min_version: '128.0' },
    },
  };
}

export function manifestText(source) {
  return JSON.stringify(buildManifest(source), null, 2) + '\n';
}

/**
 * La notice d'installation embarque le script à copier : elle doit donc être
 * régénérée en même temps, sans quoi les collègues installeraient une version
 * périmée.
 */
export function buildDoc(source, template, iconBase64) {
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return template
    .replace('{{SCRIPT}}', escaped)
    .replace('{{ICON}}', iconBase64)
    .replace('{{VERSION}}', readVersion(source));
}

function main() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  fs.mkdirSync(path.dirname(CONTENT), { recursive: true });
  fs.writeFileSync(CONTENT, buildContent(source));
  fs.writeFileSync(MANIFEST, manifestText(source));

  const template = fs.readFileSync(DOC_TEMPLATE, 'utf8');
  const icon = fs.readFileSync(ICON).toString('base64');
  fs.writeFileSync(DOC, buildDoc(source, template, icon));

  console.log(`LazyQ v${readVersion(source)} — extension/ et docs/installation.html régénérés`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

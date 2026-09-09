// ==UserScript==
// @name         HubSpot — Qualification rapide d'appel
// @namespace    https://webdentiste.eu/
// @version      0.1.0
// @description  Qualifie l'appel ouvert sur une fiche contact HubSpot (type + résultat) en un raccourci clavier.
// @match        https://app.hubspot.com/*
// @match        https://app-eu1.hubspot.com/*
// @match        https://app-na1.hubspot.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration — c'est la seule partie à modifier au quotidien.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    // Les actions sont jouées dans l'ordre, séquentiellement.
    // `field` = libellés possibles du champ (FR + EN, HubSpot bascule selon la langue du user).
    // `value` = libellé exact de l'option à sélectionner.
    actions: [
      {
        name: "Type d'appel",
        field: ["type d'appel", 'call type', "type d'activité", 'activity type', 'type'],
        value: 'Call Commercial : prospection',
      },
      {
        name: "Résultat de l'appel",
        field: ["résultat de l'appel", 'call outcome', 'résultat', 'outcome'],
        value: 'Répondeur/Pas de réponse',
      },
    ],

    // Enregistre l'appel après les actions (cherche un bouton Enregistrer / Save).
    // À laisser sur false tant que tu valides le comportement.
    autoSave: false,

    // Raccourcis. `key` est comparé en minuscule.
    hotkey: { key: 'k', ctrlKey: true, shiftKey: true, altKey: false },
    probeHotkey: { key: 'j', ctrlKey: true, shiftKey: true, altKey: false },

    // Bouton flottant en bas à droite (utile pour tester sans raccourci).
    showButton: true,

    // Délai max d'attente pour qu'un champ ou une option apparaisse.
    timeoutMs: 4000,
  };

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------

  /** Normalise pour comparer des libellés : sans accents, sans casse, espaces compactés. */
  function norm(str) {
    return (str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // dépose les diacritiques
      .toLowerCase()
      .replace(/\s*:\s*/g, ':')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Rejoue `fn` toutes les 100 ms jusqu'à ce qu'elle renvoie une valeur truthy, ou timeout. */
  async function waitFor(fn, timeoutMs = CONFIG.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await sleep(100);
    }
    return null;
  }

  /** Séquence souris complète : certains composants HubSpot écoutent mousedown, pas click. */
  function realClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  /** Écrit dans un input contrôlé par React (le setter natif contourne le state interne). */
  function setReactValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------------------------------------------------------------------------
  // Détection des champs
  // ---------------------------------------------------------------------------

  const TRIGGER_SELECTOR = [
    'select',
    '[role="combobox"]',
    'button[aria-haspopup]',
    '[data-test-id*="select"] button',
    '[class*="select"] button',
    'input[readonly]',
    'button',
  ];

  /** Retourne les noeuds de texte qui ressemblent au libellé d'un des `names`. */
  function findLabelNodes(root, names) {
    const wanted = names.map(norm);
    const out = [];
    for (const node of root.querySelectorAll('label, span, div, legend, h4, h5')) {
      if (node.children.length > 2) continue; // on veut une feuille de texte, pas un conteneur
      const text = norm(node.textContent);
      if (!text || text.length > 60) continue;
      const hit = wanted.some((w) => text === w || text === w + ' *' || text.startsWith(w));
      if (hit && isVisible(node)) out.push(node);
    }
    // Les libellés les plus courts d'abord : "type d'appel" avant "type d'appel (obligatoire)".
    return out.sort((a, b) => a.textContent.length - b.textContent.length);
  }

  /** Depuis un libellé, remonte jusqu'au conteneur qui porte le déclencheur du menu. */
  function triggerNear(labelNode) {
    if (labelNode.htmlFor) {
      const byFor = document.getElementById(labelNode.htmlFor);
      if (byFor && isVisible(byFor)) return byFor;
    }
    let el = labelNode.parentElement;
    for (let depth = 0; depth < 6 && el; depth += 1, el = el.parentElement) {
      for (const selector of TRIGGER_SELECTOR) {
        const candidate = [...el.querySelectorAll(selector)].find(isVisible);
        if (candidate) return candidate;
      }
    }
    return null;
  }

  /** Le déclencheur du champ décrit par `names`, dans l'éditeur d'appel courant. */
  function findTrigger(names) {
    for (const label of findLabelNodes(document, names)) {
      const trigger = triggerNear(label);
      if (trigger) return { trigger, label };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Sélection d'une option
  // ---------------------------------------------------------------------------

  const OPTION_SELECTOR = [
    '[role="option"]',
    '[data-test-id*="option"]',
    '[role="listbox"] li',
    '[role="menuitem"]',
    '[class*="dropdown"] li',
    '[class*="menu"] li',
    '[class*="select"] li',
  ].join(', ');

  function visibleOptions() {
    return [...document.querySelectorAll(OPTION_SELECTOR)].filter(isVisible);
  }

  function matchOption(options, wanted) {
    const w = norm(wanted);
    return (
      options.find((o) => norm(o.textContent) === w) ||
      options.find((o) => norm(o.textContent).includes(w)) ||
      null
    );
  }

  /** Champ d'input dans le menu ouvert, pour filtrer une longue liste. */
  function openSearchInput() {
    return [...document.querySelectorAll('input:not([type="hidden"])')]
      .filter(isVisible)
      .find((i) => i.getAttribute('role') === 'combobox' || /search|recherch|filtr/i.test(
        (i.placeholder || '') + (i.getAttribute('aria-label') || '')
      ));
  }

  /** Ouvre le champ, sélectionne l'option, renvoie true si ça a marché. */
  async function selectValue(action) {
    const found = findTrigger(action.field);
    if (!found) {
      log(`Champ introuvable : ${action.name}`);
      return false;
    }
    const { trigger } = found;

    // Cas simple : un vrai <select> natif.
    if (trigger.tagName === 'SELECT') {
      const option = [...trigger.options].find((o) => norm(o.textContent) === norm(action.value));
      if (!option) {
        log(`Option absente du <select> : ${action.value}`);
        return false;
      }
      trigger.value = option.value;
      trigger.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    realClick(trigger);

    // Laisse le menu se peindre, puis tente une sélection directe.
    await sleep(250);
    let option = matchOption(visibleOptions(), action.value);

    // Liste longue : on filtre par saisie avant de re-chercher.
    if (!option) {
      const search = openSearchInput();
      if (search) {
        setReactValue(search, action.value);
        await sleep(350);
      }
      option = await waitFor(() => matchOption(visibleOptions(), action.value));
    }

    if (!option) {
      log(`Option introuvable : « ${action.value} » (champ ${action.name})`);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    realClick(option);
    await sleep(200);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Enregistrement
  // ---------------------------------------------------------------------------

  async function save() {
    const button = [...document.querySelectorAll('button')]
      .filter(isVisible)
      .find((b) => ['enregistrer', 'save'].includes(norm(b.textContent)));
    if (!button) {
      log('Bouton Enregistrer introuvable');
      return false;
    }
    realClick(button);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      for (const action of CONFIG.actions) {
        toast(`… ${action.name}`, 'pending');
        const ok = await selectValue(action);
        if (!ok) {
          toast(`Échec : ${action.name}`, 'error');
          return;
        }
      }
      if (CONFIG.autoSave) await save();
      toast('Appel qualifié ✓', 'success');
    } catch (err) {
      console.error('[hs-quick-call]', err);
      toast('Erreur — voir la console', 'error');
    } finally {
      running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Mode sonde — dump ce que le script voit, pour ajuster les sélecteurs
  // ---------------------------------------------------------------------------

  function describe(el) {
    return {
      tag: el.tagName.toLowerCase(),
      texte: (el.textContent || '').trim().slice(0, 60),
      ariaLabel: el.getAttribute('aria-label'),
      dataTestId: el.getAttribute('data-test-id') || el.getAttribute('data-selenium-test'),
      classes: (el.className || '').toString().slice(0, 80),
    };
  }

  function probe() {
    console.group('[hs-quick-call] sonde');

    for (const action of CONFIG.actions) {
      const labels = findLabelNodes(document, action.field);
      console.log(`Champ « ${action.name} » — ${labels.length} libellé(s) candidat(s)`);
      console.table(labels.map(describe));
      const found = findTrigger(action.field);
      console.log('Déclencheur retenu :', found ? describe(found.trigger) : 'AUCUN', found?.trigger);
    }

    const options = visibleOptions();
    console.log(`Options actuellement visibles : ${options.length}`);
    console.table(options.slice(0, 40).map(describe));

    const triggers = [...document.querySelectorAll('[role="combobox"], button[aria-haspopup], select')]
      .filter(isVisible);
    console.log(`Tous les menus visibles de la page : ${triggers.length}`);
    console.table(triggers.map(describe));

    console.groupEnd();
    window.__hsProbe = { triggers, options };
    toast('Sonde envoyée dans la console', 'success');
  }

  // ---------------------------------------------------------------------------
  // UI : toast + bouton flottant
  // ---------------------------------------------------------------------------

  const COLORS = { pending: '#516f90', success: '#00a4bd', error: '#f2545b' };
  let toastEl = null;

  function toast(message, kind = 'pending') {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', bottom: '76px', right: '20px', zIndex: '2147483647',
        padding: '10px 14px', borderRadius: '6px', color: '#fff',
        font: '500 13px/1.4 system-ui, sans-serif', boxShadow: '0 2px 12px rgba(0,0,0,.25)',
        pointerEvents: 'none', transition: 'opacity .2s',
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.background = COLORS[kind] || COLORS.pending;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => { toastEl.style.opacity = '0'; }, 3000);
  }

  function log(message) {
    console.warn('[hs-quick-call]', message);
  }

  function mountButton() {
    if (!CONFIG.showButton || document.getElementById('hs-quick-call-btn')) return;
    const button = document.createElement('button');
    button.id = 'hs-quick-call-btn';
    button.textContent = '⚡ Qualifier l\'appel';
    Object.assign(button.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483646',
      padding: '10px 16px', borderRadius: '24px', border: 'none', cursor: 'pointer',
      background: '#ff7a59', color: '#fff', font: '600 13px/1 system-ui, sans-serif',
      boxShadow: '0 2px 12px rgba(0,0,0,.25)',
    });
    button.addEventListener('click', run);
    document.body.appendChild(button);
  }

  function matchesHotkey(event, hotkey) {
    return (
      event.key.toLowerCase() === hotkey.key &&
      event.ctrlKey === !!hotkey.ctrlKey &&
      event.shiftKey === !!hotkey.shiftKey &&
      event.altKey === !!hotkey.altKey
    );
  }

  document.addEventListener('keydown', (event) => {
    if (matchesHotkey(event, CONFIG.hotkey)) {
      event.preventDefault();
      run();
    } else if (matchesHotkey(event, CONFIG.probeHotkey)) {
      event.preventDefault();
      probe();
    }
  }, true);

  // HubSpot est une SPA : le bouton disparaît à chaque navigation interne.
  new MutationObserver(mountButton).observe(document.body, { childList: true, subtree: false });
  mountButton();

  // Accès manuel depuis la console pour tester pas à pas.
  window.hsQuickCall = { run, probe, selectValue, findTrigger, visibleOptions, CONFIG };

  console.info('[hs-quick-call] chargé — Ctrl+Shift+K pour qualifier, Ctrl+Shift+J pour sonder');
})();

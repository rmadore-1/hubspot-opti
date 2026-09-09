// ==UserScript==
// @name         HubSpot — Qualification rapide d'appel
// @namespace    https://webdentiste.eu/
// @version      1.0.0
// @description  Qualifie l'appel ouvert sur une fiche contact HubSpot (type + résultat) en un raccourci clavier.
// @match        https://app.hubspot.com/*
// @match        https://app-eu1.hubspot.com/*
// @match        https://app-na1.hubspot.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// L'app HubSpot est un assemblage d'iframes : la fiche contact et le widget
// d'appel (/calling/.../twilio) sont des documents distincts. Le script est donc
// injecté dans chaque frame ; celle qui contient réellement les champs se
// déclare et exécute les actions, les autres restent passives. Le pilotage
// (bouton, bandeau, raccourcis) vit dans la frame principale et parle aux
// autres par postMessage.

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
        field: ["type d'appel", 'call type', "type d'activité", 'activity type'],
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

    // Raccourci par défaut. Un clic droit sur le bouton le remplace, et le
    // nouveau est mémorisé dans le navigateur. `key` est comparé en minuscule.
    hotkey: { key: 'k', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },


    // Bouton flottant en bas à droite (frame principale uniquement).
    showButton: true,
    buttonLabel: 'Répondeur / Prospection',

    // Délai max d'attente pour qu'un champ ou une option apparaisse.
    timeoutMs: 4000,
  };

  const IS_TOP = window.top === window;
  const FRAME = IS_TOP ? 'principale' : location.pathname;

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
  function findLabelNodes(names) {
    const wanted = names.map(norm);
    const out = [];
    for (const node of document.querySelectorAll('label, span, div, legend, h4, h5')) {
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

  /** Le déclencheur du champ décrit par `names`, dans le document courant. */
  function findTrigger(names) {
    for (const label of findLabelNodes(names)) {
      const trigger = triggerNear(label);
      if (trigger) return { trigger, label };
    }
    return null;
  }

  /** Cette frame contient-elle les champs de toutes les actions ? */
  function hasAllFields() {
    return CONFIG.actions.every((action) => findTrigger(action.field));
  }

  // ---------------------------------------------------------------------------
  // Sélection d'une option
  // ---------------------------------------------------------------------------

  // Rôles ARIA d'abord : c'est ce que rend un vrai menu ouvert.
  const OPTION_SELECTOR = '[role="option"], [role="menuitem"], [role="listbox"] li, [role="menu"] li';

  // Repli pour les composants qui ne posent pas de rôle. Ratisse large — la
  // barre latérale et les listes de propriétés matchent aussi — donc à
  // n'utiliser que sur les éléments apparus après le clic.
  const BROAD_OPTION_SELECTOR = [
    OPTION_SELECTOR,
    '[data-test-id*="option"]',
    '[class*="option"]',
    '[class*="dropdown"] li',
    '[class*="menu"] li',
    '[class*="select"] li',
  ].join(', ');

  function optionNodes(broad) {
    return [...document.querySelectorAll(broad ? BROAD_OPTION_SELECTOR : OPTION_SELECTOR)]
      .filter(isVisible);
  }

  function matchOption(options, wanted) {
    const w = norm(wanted);
    return (
      options.find((o) => norm(o.textContent) === w) ||
      options.find((o) => norm(o.textContent).includes(w)) ||
      null
    );
  }

  /** Valeur actuellement portée par un déclencheur. */
  function readValue(el) {
    if (el.tagName === 'SELECT') return (el.options[el.selectedIndex] || {}).textContent || '';
    if (el.tagName === 'INPUT') return el.value || '';
    return el.textContent || '';
  }

  /** Ouvre le champ, sélectionne l'option, vérifie que la valeur a bien pris. */
  async function selectValue(action) {
    const found = findTrigger(action.field);
    if (!found) return { ok: false, why: `champ introuvable : ${action.name}` };
    const { trigger } = found;

    if (norm(readValue(trigger)).includes(norm(action.value))) {
      return { ok: true, note: `${action.name} déjà à la bonne valeur` };
    }

    // Cas simple : un vrai <select> natif.
    if (trigger.tagName === 'SELECT') {
      const option = [...trigger.options].find((o) => norm(o.textContent) === norm(action.value));
      if (!option) return { ok: false, why: `option absente du <select> : ${action.value}` };
      trigger.value = option.value;
      trigger.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }

    // La page porte en permanence des éléments qui ressemblent à des options :
    // navigation, listes de propriétés, et surtout l'affichage des valeurs
    // courantes — un span « Répondeur/Pas de réponse » existe déjà avant tout
    // clic. Chercher dans toute la page reviendrait donc à cliquer ce span.
    // On ne retient que ce qui apparaît à l'ouverture du menu.
    const baseline = optionNodes(true).length;

    const openAndFind = async () => {
      const optionsBefore = new Set(optionNodes(true));
      const inputsBefore = new Set(document.querySelectorAll('input'));

      realClick(trigger);
      await sleep(250);

      const fresh = (broad) => optionNodes(broad).filter((el) => !optionsBefore.has(el));
      const look = () => matchOption(fresh(false), action.value) || matchOption(fresh(true), action.value);

      if (look()) return look();

      // Liste longue : on filtre par saisie avant de re-chercher.
      const searchInput = [...document.querySelectorAll('input:not([type="hidden"])')]
        .find((i) => !inputsBefore.has(i) && isVisible(i))
        || (trigger.tagName === 'INPUT' ? trigger : null);
      if (searchInput) {
        setReactValue(searchInput, action.value);
        await sleep(350);
      }
      return waitFor(look);
    };

    // Si un menu était déjà ouvert, il figure dans la photo « avant » et le diff
    // ne voit rien. Le premier clic l'a alors refermé : on retente, la seconde
    // photo partant cette fois d'un état fermé.
    const option = (await openAndFind()) || (await openAndFind());

    if (!option) {
      // Escape ne referme un menu que s'il y en a un : sans menu ouvert, il
      // risquerait de refermer l'éditeur d'appel et de perdre la saisie.
      if (optionNodes(true).length > baseline) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      return { ok: false, why: `option introuvable : « ${action.value} » (${action.name})` };
    }

    realClick(option);

    // React remonte souvent un nouveau noeud : on relit le champ plutôt que de
    // garder la référence d'avant le clic.
    const confirmed = await waitFor(() => {
      const again = findTrigger(action.field);
      return again && norm(readValue(again.trigger)).includes(norm(action.value)) ? true : null;
    }, 2000);

    return confirmed
      ? { ok: true }
      : { ok: true, unverified: true, why: `${action.name} : option cliquée, valeur non confirmée` };
  }

  async function save() {
    const button = [...document.querySelectorAll('button')]
      .filter(isVisible)
      .find((b) => ['enregistrer', 'save'].includes(norm(b.textContent)));
    if (!button) return false;
    realClick(button);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Exécution (dans la frame qui possède les champs)
  // ---------------------------------------------------------------------------

  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      const warnings = [];
      for (const action of CONFIG.actions) {
        report('pending', `… ${action.name}`);
        const result = await selectValue(action);
        if (!result.ok) {
          console.warn('[hs-quick-call]', result.why);
          report('error', `Échec — ${result.why}`);
          return;
        }
        if (result.why) { console.warn('[hs-quick-call]', result.why); warnings.push(result.why); }
        if (result.note) console.info('[hs-quick-call]', result.note);
      }
      if (CONFIG.autoSave && !(await save())) {
        report('error', 'Champs remplis, mais bouton Enregistrer introuvable');
        return;
      }
      report(warnings.length ? 'error' : 'success',
        warnings.length ? `À vérifier — ${warnings.join(' ; ')}` : 'Appel qualifié');
    } catch (err) {
      console.error('[hs-quick-call]', err);
      report('error', 'Erreur — voir la console');
    } finally {
      running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Communication inter-frames
  // ---------------------------------------------------------------------------

  /** Envoie un message à toutes les frames de l'onglet, la principale incluse. */
  function broadcast(payload) {
    const seen = new Set();
    (function walk(win) {
      if (!win || seen.has(win)) return;
      seen.add(win);
      try { win.postMessage({ __hsQuickCall: payload }, '*'); } catch (_) { /* cross-origin */ }
      let count = 0;
      try { count = win.frames.length; } catch (_) { return; }
      for (let i = 0; i < count; i += 1) {
        try { walk(win.frames[i]); } catch (_) { /* cross-origin */ }
      }
    })(window.top);
  }

  function toTop(payload) {
    try { window.top.postMessage({ __hsQuickCall: payload }, '*'); } catch (_) { /* ignore */ }
  }

  /** Remonte un état à la frame principale, qui l'affiche. */
  function report(kind, text) {
    toTop({ type: 'status', kind, text });
  }

  let claimed = false;
  let probeReports = [];

  window.addEventListener('message', (event) => {
    const msg = event.data && event.data.__hsQuickCall;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'run':
        // Seule la frame qui porte tous les champs se déclare et exécute.
        if (hasAllFields()) {
          toTop({ type: 'claim', frame: FRAME });
          run();
        }
        break;

      case 'probe':
        toTop({ type: 'probeReport', text: probeText() });
        break;

      case 'claim':
        if (IS_TOP) claimed = true;
        break;

      case 'status':
        if (IS_TOP) toast(msg.text, msg.kind);
        break;

      case 'probeReport':
        if (IS_TOP) probeReports.push(msg.text);
        break;

      case 'hotkeyChanged':
        hotkey = msg.hotkey;
        refreshButtonTitle();
        break;
    }
  });

  /** Déclenche depuis n'importe quelle frame (le focus clavier peut être partout). */
  function trigger() {
    claimed = false;
    broadcast({ type: 'run' });
    // Si aucune frame ne se déclare, c'est un problème de ciblage, pas d'exécution.
    setTimeout(() => {
      if (!claimed) toast('Champs introuvables — lance la sonde (Ctrl+Shift+J)', 'error');
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Mode sonde — diagnostic, sans bouton ni raccourci
  //
  // Ne sert que le jour où le ciblage casse : hsQuickCall.probe() depuis la
  // console imprime, frame par frame, les libellés candidats, le déclencheur
  // retenu, sa valeur courante et les menus visibles.
  // ---------------------------------------------------------------------------

  function describe(el) {
    const attrs = [
      el.tagName.toLowerCase(),
      el.getAttribute('data-test-id') && `test-id=${el.getAttribute('data-test-id')}`,
      el.getAttribute('data-selenium-test') && `selenium=${el.getAttribute('data-selenium-test')}`,
      el.getAttribute('aria-label') && `aria=${el.getAttribute('aria-label')}`,
    ].filter(Boolean);
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `[${attrs.join(' ')}] "${text}"`;
  }

  function probeText() {
    const lines = [`=== FRAME ${FRAME} ===`];

    for (const action of CONFIG.actions) {
      const labels = findLabelNodes(action.field);
      lines.push(`Champ « ${action.name} » — ${labels.length} libellé(s)`);
      labels.slice(0, 5).forEach((l) => lines.push(`    libellé ${describe(l)}`));
      const found = findTrigger(action.field);
      lines.push(`    déclencheur = ${found ? describe(found.trigger) : 'AUCUN'}`);
      if (found) lines.push(`    valeur actuelle = "${readValue(found.trigger).trim().slice(0, 60)}"`);
    }

    const triggers = [...document.querySelectorAll('[role="combobox"], button[aria-haspopup], select')]
      .filter(isVisible);
    lines.push(`Menus visibles (${triggers.length}) :`);
    triggers.slice(0, 25).forEach((t) => lines.push(`    ${describe(t)}`));

    // Compte brut, hors diff : la page en porte des dizaines en permanence.
    // Ce que le script retient réellement, ce sont les nouveaux après clic.
    const options = optionNodes(false);
    lines.push(`Candidats « option » présents sur la page (${options.length}) :`);
    options.slice(0, 40).forEach((o) => lines.push(`    ${describe(o)}`));

    return lines.join('\n');
  }

  /** Collecte les rapports de toutes les frames et les affiche. */
  function probe() {
    probeReports = [];
    broadcast({ type: 'probe' });
    setTimeout(() => {
      const text = probeReports.join('\n\n') || "(aucune frame n'a répondu)";
      window.__hsProbe = text;
      console.log('[hs-quick-call] SONDE\n' + text);
      showReport(text);
    }, 800);
  }

  // ---------------------------------------------------------------------------
  // UI — frame principale uniquement
  // ---------------------------------------------------------------------------

  const COLORS = { pending: '#516f90', success: '#00a4bd', error: '#f2545b' };
  let toastEl = null;

  function toast(message, kind = 'pending') {
    if (!IS_TOP) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', bottom: '76px', right: '20px', zIndex: '2147483647',
        padding: '10px 14px', borderRadius: '6px', color: '#fff', maxWidth: '340px',
        font: '500 13px/1.4 system-ui, sans-serif', boxShadow: '0 2px 12px rgba(0,0,0,.25)',
        pointerEvents: 'none', transition: 'opacity .2s',
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.background = COLORS[kind] || COLORS.pending;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => { toastEl.style.opacity = '0'; }, 4000);
  }

  function makeButton(label, background, onClick, title) {
    const button = document.createElement('button');
    button.textContent = label;
    if (title) button.title = title;
    Object.assign(button.style, {
      padding: '10px 16px', borderRadius: '24px', border: 'none', cursor: 'pointer',
      background, color: '#fff', font: '600 13px/1 system-ui, sans-serif',
      boxShadow: '0 2px 12px rgba(0,0,0,.25)',
    });
    button.addEventListener('click', onClick);
    return button;
  }

  let actionButton = null;

  function refreshButtonTitle() {
    if (actionButton) {
      actionButton.title =
        `Clic : qualifier l'appel (${describeHotkey(hotkey)})\nClic droit : changer le raccourci`;
    }
  }

  function mountButton() {
    if (!IS_TOP || !CONFIG.showButton) return;
    if (document.getElementById('hs-quick-call-ui')) return;

    actionButton = makeButton(CONFIG.buttonLabel, '#ff7a59', trigger);
    actionButton.id = 'hs-quick-call-ui';
    Object.assign(actionButton.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483646',
    });
    actionButton.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      captureHotkey();
    });
    refreshButtonTitle();
    document.body.appendChild(actionButton);
  }

  // Le presse-papier via navigator.clipboard exige une activation utilisateur
  // transitoire : la sonde collecte les frames de façon asynchrone, donc au
  // moment de copier le geste a expiré et l'appel est rejeté. On affiche donc
  // le rapport déjà sélectionné — Cmd+C / Ctrl+C suffit.
  let panelEl = null;

  function showReport(text) {
    if (!IS_TOP) return;
    if (panelEl) panelEl.remove();

    panelEl = document.createElement('div');
    Object.assign(panelEl.style, {
      position: 'fixed', bottom: '76px', right: '20px', zIndex: '2147483647',
      width: 'min(560px, 90vw)', background: '#fff', borderRadius: '8px',
      border: '1px solid #cbd6e2', boxShadow: '0 4px 24px rgba(0,0,0,.25)',
      padding: '12px', font: '13px/1.4 system-ui, sans-serif', color: '#33475b',
      display: 'flex', flexDirection: 'column', gap: '8px',
    });

    const title = document.createElement('strong');
    title.textContent = 'Sonde — tout est sélectionné, Cmd+C pour copier';

    const area = document.createElement('textarea');
    area.readOnly = true;
    area.value = text;
    Object.assign(area.style, {
      width: '100%', height: '320px', resize: 'vertical', boxSizing: 'border-box',
      font: '12px/1.4 ui-monospace, Menlo, monospace', padding: '8px',
      border: '1px solid #cbd6e2', borderRadius: '4px', background: '#f5f8fa',
    });

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px' });

    // Dans un handler de clic l'activation est fraîche : les deux voies marchent.
    const copy = makeButton('Copier', '#00a4bd', () => {
      area.focus();
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => { copy.textContent = 'Copié'; }).catch(() => {});
      }
      copy.textContent = ok ? 'Copié' : 'Fais Cmd+C';
    });
    const close = makeButton('Fermer', '#7c98b6', () => { panelEl.remove(); panelEl = null; });

    row.append(copy, close);
    panelEl.append(title, area, row);
    document.body.appendChild(panelEl);

    area.focus();
    area.select();
  }

  // ---------------------------------------------------------------------------
  // Raccourci : modifiable au clic droit, mémorisé par navigateur
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = 'hsQuickCall.hotkey';

  function loadHotkey() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return stored && typeof stored.key === 'string' ? stored : null;
    } catch (_) {
      return null; // navigation privée, stockage bloqué
    }
  }

  let hotkey = loadHotkey() || CONFIG.hotkey;

  function describeHotkey(h) {
    const parts = [];
    if (h.ctrlKey) parts.push('Ctrl');
    if (h.metaKey) parts.push('Cmd');
    if (h.altKey) parts.push('Alt');
    if (h.shiftKey) parts.push('Maj');
    parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key);
    return parts.join('+');
  }

  function matchesHotkey(event, h) {
    return (
      event.key.toLowerCase() === h.key &&
      event.ctrlKey === !!h.ctrlKey &&
      event.shiftKey === !!h.shiftKey &&
      event.altKey === !!h.altKey &&
      event.metaKey === !!h.metaKey
    );
  }

  let capturing = null;

  /** Attend la prochaine combinaison et l'enregistre. */
  function captureHotkey() {
    if (capturing) return;
    toast('Appuie sur la nouvelle combinaison (Échap pour annuler)', 'pending');

    const stop = () => {
      document.removeEventListener('keydown', onKey, true);
      capturing = null;
    };

    const onKey = (event) => {
      // On ignore les modificateurs seuls : on attend la vraie touche.
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        stop();
        toast(`Raccourci inchangé (${describeHotkey(hotkey)})`, 'pending');
        return;
      }

      const next = {
        key: event.key.toLowerCase(),
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      };
      // Une touche nue serait déclenchée en tapant dans une note : on l'écarte.
      if (!next.ctrlKey && !next.altKey && !next.metaKey) {
        toast('Ajoute au moins Ctrl, Alt ou Cmd — sinon tu le déclencherais en tapant', 'error');
        return;
      }

      setHotkey(next);
      stop();
      toast(`Raccourci : ${describeHotkey(next)}`, 'success');
    };

    capturing = onKey;
    document.addEventListener('keydown', onKey, true);
  }

  function setHotkey(next) {
    hotkey = next;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (_) { /* stockage bloqué */ }
    refreshButtonTitle();
    // Les iframes écoutent aussi le clavier : elles doivent connaître le nouveau.
    broadcast({ type: 'hotkeyChanged', hotkey: next });
  }

  // Écouté dans chaque frame : le focus clavier peut être dans le widget d'appel.
  document.addEventListener('keydown', (event) => {
    if (matchesHotkey(event, hotkey)) {
      event.preventDefault();
      IS_TOP ? trigger() : toTop({ type: 'hotkey' });
    }
  }, true);

  // La frame principale relaie les raccourcis captés par les iframes.
  if (IS_TOP) {
    window.addEventListener('message', (event) => {
      const msg = event.data && event.data.__hsQuickCall;
      if (msg && msg.type === 'hotkey') trigger();
    });
  }

  // HubSpot est une SPA : le bouton disparaît à chaque navigation interne.
  new MutationObserver(mountButton).observe(document.body, { childList: true, subtree: false });
  mountButton();

  // Accès manuel depuis la console, frame par frame.
  window.hsQuickCall = {
    run, probe, probeText, trigger, selectValue, findTrigger, optionNodes, readValue,
    hasAllFields, captureHotkey, describeHotkey, matchesHotkey,
    get hotkey() { return hotkey; },
    CONFIG,
  };

  console.info(`[hs-quick-call] chargé (frame ${FRAME}) — ${describeHotkey(hotkey)} pour qualifier, hsQuickCall.probe() pour diagnostiquer`);
})();

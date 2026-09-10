// ==UserScript==
// @name         LazyQ — qualification rapide d'appel HubSpot
// @namespace    https://webdentiste.eu/
// @version      3.6.0
// @description  Qualifie l'appel ouvert sur une fiche contact HubSpot en un clic ou un raccourci, avec des combinaisons configurables.
// @match        https://app.hubspot.com/*
// @match        https://app-eu1.hubspot.com/*
// @match        https://app-na1.hubspot.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// L'app HubSpot est un assemblage d'iframes : la fiche contact et le widget
// d'appel (/calling/.../twilio) sont des documents distincts. Le script est
// injecté dans chaque frame ; celle qui contient les champs exécute, les autres
// restent passives. Le pilotage (boutons, réglages) vit dans la frame
// principale et parle aux autres par postMessage.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const CONFIG = {
    // Les champs que le script sait lire et remplir. `labels` liste les
    // intitulés possibles (HubSpot bascule FR/EN selon la langue du user).
    fields: [
      { name: "Type d'appel", labels: ["type d'appel", 'call type', "type d'activité", 'activity type'] },
      { name: "Résultat de l'appel", labels: ["résultat de l'appel", 'call outcome', 'résultat', 'outcome'] },
    ],

    // Combinaison livrée par défaut. Ensuite tout se gère depuis ⚙︎.
    defaultPresets: [{
      id: 'repondeur-prospection',
      label: 'Répondeur / Prospection',
      visible: true,
      autoASR: false,
      hotkey: { key: 'k', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
      values: {
        "Type d'appel": 'Call Commercial : prospection',
        "Résultat de l'appel": 'Répondeur/Pas de réponse',
      },
    }],

    // Propriété pilotée par l'option « Auto ASR », en dehors des combinaisons :
    // sa valeur se déduit de l'historique, elle ne s'absorbe pas.
    asrField: {
      name: 'Qualification du lead IA',
      labels: ['qualification du lead ia', 'qualification lead ia', 'ai lead qualification'],
      prefix: 'Appel sans réponse',
      max: 4,
    },

    // Repérage des cartes d'appel dans la chronologie. `cardSelectors` est
    // essayé dans l'ordre ; le premier qui donne des cartes gagne.
    timeline: {
      // Chaque activité de la chronologie porte cette ancre. La carte complète
      // est un ancêtre : on remonte depuis l'ancre plutôt que de figer un
      // niveau, les classes de HubSpot étant des hachages instables.
      // Le bloc d'accordéon est rendu une fois par événement et porte l'aperçu
      // comme l'éditeur : c'est la carte, sans remontée ni devinette.
      cardSelectors: ['[data-test-id="collapsible-event-accordion"]'],
      // Repli si ce test-id disparaît : on repart d'une ancre et on remonte.
      eventAnchors: [
        '[data-test-id="timeline-preview-event"]',
        '[data-test-id="generic-preview-event-header"]',
      ],
      // Remontée maximale depuis l'ancre pour englober la carte entière : on
      // vise le bloc d'accordéon, qui porte l'aperçu et l'éditeur déplié.
      maxClimb: 8,
      maxCardChars: 5000,
      // Ordre supposé si les dates ne sont pas lisibles.
      newestFirst: true,
    },

    // Clique Enregistrer après les actions.
    autoSave: false,

    showButtons: true,

    // Opacité des boutons flottants au repos : présents sans capter le regard.
    buttonOpacity: 0.9,

    // Attente max pour l'apparition d'un champ ou d'une option.
    timeoutMs: 4000,
  };

  // Textes qui signalent un champ vide : à ne pas absorber comme une valeur.
  const PLACEHOLDERS = ['sélectionner', 'select', 'aucun', 'none', '-', '--'];

  const IS_TOP = window.top === window;
  const FRAME = IS_TOP ? 'principale' : location.pathname;
  const STORAGE_KEY = 'lazyQ.presets.v1';
  // Clés des versions antérieures au nom LazyQ, relues une fois pour ne pas
  // faire perdre à l'utilisateur ses combinaisons et son raccourci.
  const LEGACY_PRESETS_KEY = 'hsQuickCall.presets.v1';
  const LEGACY_HOTKEY_KEY = 'hsQuickCall.hotkey';

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

  /** Rejoue `fn` toutes les 100 ms jusqu'à une valeur truthy, ou timeout. */
  async function waitFor(fn, timeoutMs = CONFIG.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await sleep(100);
    }
    return null;
  }

  /** Séquence souris complète : certains composants écoutent mousedown, pas click. */
  function realClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  /** Écrit dans un input contrôlé par React (le setter natif contourne son state). */
  function setReactValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------------------------------------------------------------------------
  // Détection des champs
  // ---------------------------------------------------------------------------

  // Le drapeau « i » n'est pas cosmétique : les classes de HubSpot sont en
  // PascalCase (UISelectOption__StyledOption), et [class*="option"] est
  // sensible à la casse — sans lui, ces sélecteurs ne matchent jamais rien.
  const TRIGGER_SELECTOR = [
    'select',
    '[role="combobox"]',
    'button[aria-haspopup]',
    '[data-test-id*="select" i] button',
    '[class*="select" i] button',
    'input[readonly]',
    'button',
  ];

  /** Noeuds de texte qui ressemblent au libellé d'un des `names`. */
  function findLabelNodes(names, root = document) {
    const wanted = names.map(norm);
    const out = [];
    for (const node of root.querySelectorAll('label, span, div, legend, h4, h5')) {
      if (node.children.length > 2) continue; // une feuille de texte, pas un conteneur
      const text = norm(node.textContent);
      if (!text || text.length > 60) continue;
      if (wanted.some((w) => text === w || text === w + ' *' || text.startsWith(w))) {
        if (isVisible(node)) out.push(node);
      }
    }
    // Les plus courts d'abord : "type d'appel" avant "type d'appel (obligatoire)".
    return out.sort((a, b) => a.textContent.length - b.textContent.length);
  }

  /** Depuis un libellé, remonte au conteneur qui porte le déclencheur du menu. */
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

  function findTrigger(names, root = document) {
    for (const label of findLabelNodes(names, root)) {
      const trigger = triggerNear(label);
      if (trigger) return { trigger, label };
    }
    return null;
  }

  /** Valeur actuellement portée par un déclencheur. */
  function readValue(el) {
    if (el.tagName === 'SELECT') return (el.options[el.selectedIndex] || {}).textContent || '';
    if (el.tagName === 'INPUT') return el.value || '';
    return el.textContent || '';
  }

  /** Descripteur de champ par nom. */
  const fieldByName = (name) => CONFIG.fields.find((f) => f.name === name);

  /** Cette frame porte-t-elle tous les champs d'une combinaison ? */
  function hasFieldsFor(preset) {
    return Object.keys(preset.values).every((name) => {
      const field = fieldByName(name);
      return field && findTrigger(field.labels);
    });
  }

  /** Lit les valeurs actuelles de tous les champs connus. */
  function readCurrentValues() {
    const values = {};
    for (const field of CONFIG.fields) {
      const found = findTrigger(field.labels);
      if (!found) continue;
      const value = readValue(found.trigger).trim();
      // Comparaison normalisée des deux côtés : la liste porte des accents.
      if (value && !PLACEHOLDERS.some((p) => norm(p) === norm(value))) values[field.name] = value;
    }
    return values;
  }

  // ---------------------------------------------------------------------------
  // Chronologie des appels
  //
  // Une combinaison s'applique au dernier appel, pas à celui qui est ouvert :
  // c'est presque toujours celui qu'on vient de passer. L'absorption, elle,
  // continue de lire l'appel affiché — on absorbe ce qu'on voit.
  // ---------------------------------------------------------------------------

  // Numéros français et internationaux.
  const PHONE_RE = /(?:\+\d{1,3}[\s.\-]?)?(?:\d[\s.\-]?){8,13}\d/g;

  // « 10 sept. 2026 à 11:53 » colle au numéro dans le texte d'une carte, et
  // l'espace étant un séparateur admis, le 10 se retrouvait aspiré dans le
  // numéro. On retire donc les dates avant de chercher.
  const DATE_RE = /\d{1,2}\s+[a-zéûà]+\.?\s+\d{4}(?:\s+à\s+\d{1,2}:\d{2})?/gi;

  /** Les 9 derniers chiffres : compare un 06… avec un +336… sans faux négatif. */
  function phoneKey(raw) {
    const digits = (raw || '').replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : '';
  }

  // La carte annonce l'interlocuteur par « avec +33 6 … ». Le reste du bloc
  // charrie des identifiants et des durées qui passeraient pour des numéros.
  const WITH_PHONE_RE = /\bavec\s+((?:\+\d{1,3}[\s.\-]?)?(?:\d[\s.\-]?){8,13}\d)/gi;

  function phonesIn(text) {
    const withoutDates = (text || '').replace(DATE_RE, ' ');

    const announced = [...withoutDates.matchAll(WITH_PHONE_RE)].map((m) => phoneKey(m[1])).filter(Boolean);
    if (announced.length) return [...new Set(announced)];

    return [...new Set((withoutDates.match(PHONE_RE) || []).map(phoneKey).filter(Boolean))];
  }

  const MONTHS = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];

  /** Horodatage d'une carte, ou null : « 10 sept. 2026 à 11:53 ». */
  function cardDate(text) {
    const match = norm(text).match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})(?:\s+a\s+(\d{1,2}):(\d{2}))?/);
    if (!match) return null;
    const month = MONTHS.findIndex((name) => match[2].startsWith(name));
    if (month < 0) return null;
    return new Date(Number(match[3]), month, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0)).getTime();
  }

  /**
   * Remonte de l'ancre d'événement jusqu'à la carte complète : on s'arrête dès
   * que le noeud contient un numéro, et jamais au point d'englober un autre
   * événement — ce qui ferait passer deux appels pour un seul.
   */
  function cardRoot(anchor, anchors) {
    // Le clone d'accessibilité porte le même texte que l'aperçu visible : il
    // faut le traverser pour atteindre le bloc commun, sans jamais franchir la
    // frontière d'un autre événement.
    const isClone = (other) => norm(other.textContent) === norm(anchor.textContent);

    let node = anchor;
    for (let climb = 0; climb < CONFIG.timeline.maxClimb; climb += 1) {
      const parent = node.parentElement;
      if (!parent) break;
      if (anchors.some((other) => other !== anchor && parent.contains(other) && !isClone(other))) break;
      // Garde-fou quand la fiche ne porte qu'un appel : sans autre ancre pour
      // arrêter la remontée, on finirait par prendre la page entière.
      if ((parent.textContent || '').length > CONFIG.timeline.maxCardChars) break;
      node = parent;
    }
    return node;
  }

  const isCall = (el) => /\bappel\b|\bcall\b/.test(norm(el.textContent));

  /**
   * HubSpot rend un clone d'accessibilité de l'aperçu : sans ce filtre, chaque
   * appel apparaît deux fois et « l'appel d'avant » est le même appel.
   * On garde les blocs les plus externes.
   */
  function outermost(elements) {
    return elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)));
  }

  function orderByDate(cards) {
    // Les dates priment sur l'ordre du DOM quand elles sont toutes lisibles :
    // se tromper de « dernier appel » est la pire erreur possible ici.
    const dated = cards.map((card) => ({ card, at: cardDate(card.textContent) }));
    if (dated.every((entry) => entry.at !== null)) {
      return dated.sort((a, b) => b.at - a.at).map((entry) => entry.card);
    }
    return CONFIG.timeline.newestFirst ? cards : cards.reverse();
  }

  /** Cartes d'appel de la chronologie, de la plus récente à la plus ancienne. */
  function findCallCards() {
    for (const selector of CONFIG.timeline.cardSelectors) {
      let cards;
      try { cards = [...document.querySelectorAll(selector)].filter(isVisible); } catch (_) { continue; }
      cards = outermost(cards.filter(isCall));
      if (cards.length) return orderByDate(cards);
    }

    for (const selector of CONFIG.timeline.eventAnchors) {
      let anchors;
      try { anchors = [...document.querySelectorAll(selector)].filter(isVisible); } catch (_) { continue; }
      if (!anchors.length) continue;

      const cards = [];
      for (const anchor of anchors.filter(isCall)) {
        const card = cardRoot(anchor, anchors);
        if (!cards.includes(card)) cards.push(card);
      }
      if (cards.length) return orderByDate(outermost(cards));
    }
    return [];
  }

  /** Photographie une carte : son texte survit au re-rendu, pas son noeud. */
  function cardInfo(card) {
    const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
    return { text, phones: phonesIn(text) };
  }

  function samePhone(a, b) {
    return a.phones.length > 0 && b.phones.length > 0
      && a.phones.some((phone) => b.phones.includes(phone));
  }

  /**
   * La carte porte-t-elle la catégorisation de la combinaison ?
   *
   * L'aperçu replié n'affiche que le résultat de l'appel — « Appel - Connecté »,
   * « Appel - Répondeur/Pas de réponse » — jamais le type. Exiger toutes les
   * valeurs rendrait donc le chaînage systématiquement faux : une seule suffit,
   * et c'est le résultat qui discrimine en pratique.
   */
  function cardMatchesPreset(info, preset) {
    const text = norm(info.text);
    return Object.values(preset.values).some((value) => text.includes(norm(value)));
  }

  /** La carte est-elle dépliée, c'est-à-dire ses champs sont-ils présents ? */
  function cardIsOpen(card, preset) {
    return Object.keys(preset.values).every((name) => {
      const field = fieldByName(name);
      return field && findLabelNodes(field.labels, card).length > 0;
    });
  }

  /**
   * Déplie la carte si besoin. Une carte déjà ouverte n'est pas recliquée :
   * l'accordéon se refermerait.
   */
  async function ensureCardOpen(card, preset) {
    if (cardIsOpen(card, preset)) return card;

    const toggle = [...card.querySelectorAll('[role="button"], button, [aria-expanded]')]
      .find(isVisible) || card;
    realClick(toggle);

    // React remonte la carte : on la retrouve par sa position plutôt que de
    // garder une référence morte.
    return waitFor(() => {
      const again = findCallCards()[0];
      return again && cardIsOpen(again, preset) ? again : null;
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // Escalade « Appel sans réponse N »
  // ---------------------------------------------------------------------------

  /**
   * Qualification à écrire, déduite de la seule valeur en place.
   *
   * La qualification appartient au contact, pas à l'appel : le compteur se lit
   * donc sur lui-même et n'a rien à comparer. Vide, ou portant une valeur
   * étrangère à l'échelle, il repart du premier cran ; sinon il monte d'un
   * cran et plafonne. Fonction pure, testée isolément.
   */
  function asrTarget(current, field = CONFIG.asrField) {
    const match = norm(current || '').match(new RegExp(norm(field.prefix) + '\\s*(\\d*)'));
    if (!match) return `${field.prefix} 1`;

    const rank = Number(match[1]) || 1;
    return `${field.prefix} ${Math.min(rank + 1, field.max)}`;
  }

  // ---------------------------------------------------------------------------
  // Sélection d'une option
  // ---------------------------------------------------------------------------

  // Rôles ARIA d'abord : c'est ce que rend un vrai menu ouvert.
  const OPTION_SELECTOR = '[role="option"], [role="menuitem"], [role="listbox"] li, [role="menu"] li';

  // Repli pour les composants sans rôle. Ratisse large — navigation et listes de
  // propriétés matchent aussi — donc réservé aux éléments apparus après le clic.
  const BROAD_OPTION_SELECTOR = [
    OPTION_SELECTOR,
    '[data-test-id*="option" i]',
    '[class*="option" i]',
    '[class*="dropdown" i] li',
    '[class*="menu" i] li',
    '[class*="select" i] li',
    '[class*="dropdown" i] [class*="item" i]',
    '[class*="menu" i] [class*="item" i]',
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

  /** Ouvre le champ, sélectionne l'option, vérifie que la valeur a pris. */
  async function selectValue(action, root = document) {
    const found = findTrigger(action.field, root);
    if (!found) return { ok: false, why: `champ introuvable : ${action.name}` };
    return pickOption({
      trigger: found.trigger,
      value: action.value,
      name: action.name,
      // Relire par le libellé plutôt que garder le noeud : React le remplace.
      reread: () => {
        const again = findTrigger(action.field, root);
        return again ? readValue(again.trigger) : '';
      },
    });
  }

  /**
   * Mécanique commune à tous les menus, quel que soit le moyen d'avoir obtenu
   * le déclencheur : champ d'éditeur d'appel ou propriété de la barre latérale.
   */
  async function pickOption({ trigger, value, name, reread, optionsBefore }) {
    if (norm(readValue(trigger)).includes(norm(value))) {
      return { ok: true, note: `${name} déjà à la bonne valeur` };
    }

    if (trigger.tagName === 'SELECT') {
      const option = [...trigger.options].find((o) => norm(o.textContent) === norm(value));
      if (!option) return { ok: false, why: `option absente du <select> : ${value}` };
      trigger.value = option.value;
      trigger.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }

    const baseline = optionNodes(true).length;

    // La page porte en permanence des éléments qui ressemblent à des options :
    // navigation, listes de propriétés, et surtout l'affichage des valeurs
    // courantes — un span « Répondeur/Pas de réponse » existe déjà avant tout
    // clic. Chercher dans toute la page reviendrait donc à cliquer ce span.
    // Une propriété différée rend déjà sa liste au passage en édition : sa photo
    // « avant » doit donc dater d'avant ce passage, sinon le diff est vide et
    // l'option, pourtant à l'écran, passe pour introuvable.
    const openAndFind = async (snapshot) => {
      const before = snapshot || new Set(optionNodes(true));
      const inputsBefore = new Set(document.querySelectorAll('input'));
      const fresh = (broad) => optionNodes(broad).filter((el) => !before.has(el));
      const look = () => matchOption(fresh(false), value) || matchOption(fresh(true), value);

      // Le menu peut déjà être ouvert quand la photo date d'avant l'activation :
      // une propriété différée rend sa liste dès qu'on l'active. Cliquer la
      // refermerait pour la rouvrir au tour suivant — autant la lire tout de suite.
      if (snapshot && look()) return look();

      realClick(trigger);
      await sleep(250);
      if (look()) return look();

      // Liste longue : on filtre par saisie avant de re-chercher.
      const searchInput = [...document.querySelectorAll('input:not([type="hidden"])')]
        .find((i) => !inputsBefore.has(i) && isVisible(i))
        || (trigger.tagName === 'INPUT' ? trigger : null);
      if (searchInput) {
        setReactValue(searchInput, value);
        await sleep(350);
      }
      return waitFor(look);
    };

    // Si un menu était déjà ouvert, il figure dans la photo « avant » et le diff
    // ne voit rien. Le premier clic l'a alors refermé : on retente, la seconde
    // photo partant cette fois d'un état fermé.
    // Premier essai avec la photo fournie s'il y en a une, puis à neuf : le
    // clic a pu refermer un menu déjà ouvert.
    const option = (await openAndFind(optionsBefore)) || (await openAndFind());

    if (!option) {
      // Escape ne referme un menu que s'il y en a un : sans menu ouvert, il
      // risquerait de refermer l'éditeur d'appel et de perdre la saisie.
      if (optionNodes(true).length > baseline) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      return { ok: false, why: `option introuvable : « ${value} » (${name})` };
    }

    realClick(option);

    const confirmed = await waitFor(
      () => (norm(reread()).includes(norm(value)) ? true : null), 2000);

    return confirmed
      ? { ok: true }
      : { ok: true, unverified: true, why: `${name} : option cliquée, valeur non confirmée` };
  }

  // ---------------------------------------------------------------------------
  // Propriétés différées de la barre latérale
  //
  // Une propriété comme « Qualification du lead IA » n'est pas un menu : c'est
  // un affichage en lecture seule (mode="display", role="button") qui ne devient
  // un vrai champ qu'une fois cliqué. D'où un chemin distinct des champs de
  // l'éditeur d'appel.
  // ---------------------------------------------------------------------------

  const PROPERTY_ROOT = '[data-deferred-property-input-root]';

  function findPropertyControl(labels) {
    for (const label of findLabelNodes(labels)) {
      const root = label.closest ? label.closest(PROPERTY_ROOT) : null;
      if (root && isVisible(root)) return root;
    }
    return null;
  }

  /** Valeur affichée : le texte du bloc moins celui de son libellé. */
  function readPropertyValue(root) {
    const clean = (node) => ((node && node.textContent) || '').replace(/\s+/g, ' ').trim();
    const full = clean(root);
    const label = clean(root.querySelector('label'));
    return label && full.startsWith(label) ? full.slice(label.length).trim() : full;
  }

  // HubSpot nomme le champ d'une propriété data-selenium-test="property-input-…",
  // d'après la propriété elle-même : c'est le repère le plus sûr du lot.
  const PROPERTY_INPUT = '[data-selenium-test*="property-input" i]';

  const EDIT_TRIGGER = [
    PROPERTY_INPUT,
    '[role="combobox"]',
    'button[aria-haspopup]',
    'select',
    'input:not([type="hidden"])',
    '[class*="select" i] button',
    '[data-test-id*="select" i]',
  ].join(', ');

  /** Le bouton « Actions » de la propriété : copier la valeur, etc. */
  function isActionsMenu(el) {
    return norm(el.getAttribute('aria-label') || '').includes('action')
      || el.getAttribute('aria-haspopup') === 'menu';
  }

  /**
   * Le champ éditable de la propriété, une fois celle-ci activée.
   *
   * En mode « display » il n'existe pas : ce qu'on y trouve est le menu Actions
   * du bloc. Le confondre avec l'éditeur faisait cliquer « Valeur de copie »
   * puis attendre une liste d'options qui n'arrivait jamais.
   *
   * Le mode actif porte plusieurs noms selon le type de propriété — « input »
   * pour une liste déroulante. N'exiger que « edit » refusait un champ pourtant
   * prêt : on écarte donc « display », et rien d'autre.
   */
  function propertyTrigger(field, fallback) {
    const live = findPropertyControl(field.labels) || fallback;
    if (!live || live.getAttribute('data-deferred-property-input-mode') === 'display') return null;

    const candidates = [...live.querySelectorAll(EDIT_TRIGGER)]
      .filter((el) => isVisible(el) && !isActionsMenu(el));

    // querySelectorAll rend l'ordre du document, pas celui des sélecteurs :
    // le repère nommé se choisit explicitement.
    return candidates.find((el) => el.matches(PROPERTY_INPUT)) || candidates[0] || null;
  }

  /**
   * Bascule la propriété en édition. Le bloc porte role="button" : le clic
   * suffit d'ordinaire, mais on tente aussi la touche Entrée puis un clic sur
   * la zone de valeur, certains blocs n'écoutant pas le clic sur leur racine.
   */
  async function enterEditMode(field, root) {
    if (propertyTrigger(field, root)) return true;

    const attempts = [
      () => realClick(root),
      () => {
        if (root.focus) root.focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      },
      () => {
        const inner = [...root.children].reverse().find(isVisible);
        if (inner) realClick(inner);
      },
    ];

    for (const attempt of attempts) {
      attempt();
      if (await waitFor(() => propertyTrigger(field, root), 1200)) return true;
    }
    return false;
  }

  async function setPropertyValue(field, value) {
    const root = findPropertyControl(field.labels);
    if (!root) return { ok: false, why: `propriété introuvable : ${field.name}` };

    if (norm(readPropertyValue(root)).includes(norm(value))) {
      return { ok: true, note: `${field.name} déjà à la bonne valeur` };
    }

    // Photo prise avant l'activation : le passage en édition rend parfois la
    // liste, qui serait alors comptée comme « déjà présente ».
    const optionsBefore = new Set(optionNodes(true));

    if (!(await enterEditMode(field, root))) {
      return { ok: false, why: `${field.name} : passage en édition impossible` };
    }

    const trigger = propertyTrigger(field, root);
    return pickOption({
      trigger,
      value,
      name: field.name,
      optionsBefore,
      reread: () => {
        const live = findPropertyControl(field.labels);
        return live ? readPropertyValue(live) : '';
      },
    });
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
  // Exécution d'une combinaison (dans la frame qui porte les champs)
  // ---------------------------------------------------------------------------

  /** Traduit une combinaison en actions ordonnées selon CONFIG.fields. */
  function actionsFor(preset) {
    return CONFIG.fields
      .filter((field) => preset.values[field.name])
      .map((field) => ({ name: field.name, field: field.labels, value: preset.values[field.name] }));
  }

  let running = false;

  async function runPreset(preset) {
    if (running) return;
    running = true;
    try {
      // 1. La combinaison vise le dernier appel, pas celui qui se trouve ouvert.
      const cards = findCallCards();
      if (!cards.length) {
        report('error', 'Aucun appel trouvé dans la chronologie');
        return;
      }

      report('pending', 'Ouverture du dernier appel…');
      const card = await ensureCardOpen(cards[0], preset);
      if (!card) {
        report('error', "Le dernier appel ne s'ouvre pas — champs introuvables");
        return;
      }

      // 2. Les valeurs sont cherchées dans la carte, pas dans la page : un autre
      // appel déplié ailleurs ne doit pas être rempli à sa place.
      const warnings = [];
      for (const action of actionsFor(preset)) {
        report('pending', `… ${action.name}`);
        const result = await selectValue(action, card);
        if (!result.ok) {
          console.warn('[LazyQ]', result.why);
          report('error', `Échec — ${result.why}`);
          return;
        }
        if (result.why) { console.warn('[LazyQ]', result.why); warnings.push(result.why); }
        if (result.note) console.info('[LazyQ]', result.note);
      }

      // 3. Escalade de la qualification, si l'option est cochée.
      if (preset.autoASR) {
        const outcome = await applyAutoASR();
        if (outcome.why) warnings.push(outcome.why);
        if (outcome.note) console.info('[LazyQ]', outcome.note);
      }

      if (CONFIG.autoSave && !(await save())) {
        report('error', 'Champs remplis, mais bouton Enregistrer introuvable');
        return;
      }

      report(warnings.length ? 'error' : 'success',
        warnings.length ? `À vérifier — ${warnings.join(' ; ')}` : `${preset.label} appliqué`);
    } catch (err) {
      console.error('[LazyQ]', err);
      report('error', 'Erreur — voir la console');
    } finally {
      running = false;
    }
  }

  /** Fait monter la qualification d'un cran, ou pose le premier barreau. */
  async function applyAutoASR() {
    const field = CONFIG.asrField;
    const control = findPropertyControl(field.labels);
    if (!control) return { why: `${field.name} introuvable — escalade ignorée` };

    const target = asrTarget(readPropertyValue(control));

    report('pending', `… ${field.name}`);
    const result = await setPropertyValue(field, target);
    if (!result.ok) return { why: result.why };
    return { why: result.unverified ? result.why : undefined, note: result.note || `${field.name} → ${target}` };
  }

  // ---------------------------------------------------------------------------
  // Stockage des combinaisons (la frame principale fait autorité)
  // ---------------------------------------------------------------------------

  function sanitize(preset) {
    if (!preset || typeof preset !== 'object') return null;
    const { id, label, hotkey, values } = preset;
    if (typeof label !== 'string' || !values || typeof values !== 'object') return null;
    return {
      id: typeof id === 'string' ? id : uid(),
      label,
      hotkey: hotkey && typeof hotkey.key === 'string' ? hotkey : null,
      // Option d'escalade : absente vaut désactivée, jamais activée par défaut.
      autoASR: preset.autoASR === true,
      // undefined est significatif ici : il distingue un enregistrement
      // antérieur à la visibilité d'un choix explicite de masquage.
      visible: typeof preset.visible === 'boolean' ? preset.visible : undefined,
      values,
    };
  }

  function readStored(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
  }

  function loadPresets() {
    try {
      const stored = readStored(STORAGE_KEY) || readStored(LEGACY_PRESETS_KEY);
      if (Array.isArray(stored)) {
        const clean = stored.map(sanitize).filter(Boolean);
        if (clean.length) {
          // Enregistrement d'avant la visibilité : on montre la première, on
          // masque les autres, plutôt que de laisser une barre vide.
          if (clean.every((p) => p.visible === undefined)) {
            clean.forEach((p, i) => { p.visible = i === 0; });
          } else {
            clean.forEach((p) => { p.visible = p.visible === true; });
          }
          return clean;
        }
      }
    } catch (_) { /* stockage bloqué ou illisible */ }

    // Reprise du raccourci unique des versions à combinaison unique.
    const fresh = JSON.parse(JSON.stringify(CONFIG.defaultPresets));
    const legacy = readStored(LEGACY_HOTKEY_KEY);
    if (legacy && typeof legacy.key === 'string') fresh[0].hotkey = legacy;
    return fresh;
  }

  let presets = loadPresets();

  function savePresets() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets)); } catch (_) { /* bloqué */ }
    // Les iframes écoutent aussi le clavier : elles ont besoin de la liste.
    broadcast({ type: 'presets', presets });
    renderButtons();
    renderSettings();
  }

  // ---------------------------------------------------------------------------
  // Communication inter-frames
  // ---------------------------------------------------------------------------

  /** Envoie à toutes les frames de l'onglet, la principale incluse. */
  function broadcast(payload) {
    const seen = new Set();
    (function walk(win) {
      if (!win || seen.has(win)) return;
      seen.add(win);
      try { win.postMessage({ __lazyQ: payload }, '*'); } catch (_) { /* cross-origin */ }
      let count = 0;
      try { count = win.frames.length; } catch (_) { return; }
      for (let i = 0; i < count; i += 1) {
        try { walk(win.frames[i]); } catch (_) { /* cross-origin */ }
      }
    })(window.top);
  }

  function toTop(payload) {
    try { window.top.postMessage({ __lazyQ: payload }, '*'); } catch (_) { /* ignore */ }
  }

  function report(kind, text) {
    toTop({ type: 'status', kind, text });
  }

  let claimed = false;
  let probeReports = [];
  const pendingAbsorb = new Map();

  window.addEventListener('message', (event) => {
    const msg = event.data && event.data.__lazyQ;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'run':
        // Seule la frame qui porte les champs se déclare et exécute.
        // La chronologie suffit : les champs n'existent qu'une fois l'appel
        // déplié, donc les exiger d'avance empêcherait toute exécution.
        if (findCallCards().length > 0 || hasFieldsFor(msg.preset)) {
          toTop({ type: 'claim' });
          runPreset(msg.preset);
        }
        break;

      case 'absorb': {
        // Les champs ne sont pas forcément dans la frame principale : celle qui
        // les porte renvoie ce qu'elle lit.
        const values = readCurrentValues();
        if (Object.keys(values).length) toTop({ type: 'absorbed', requestId: msg.requestId, values });
        break;
      }

      case 'absorbed': {
        const resolve = pendingAbsorb.get(msg.requestId);
        if (resolve) { pendingAbsorb.delete(msg.requestId); resolve(msg.values); }
        break;
      }

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

      case 'presets':
        if (!IS_TOP) presets = msg.presets;
        break;

      case 'needPresets':
        if (IS_TOP) broadcast({ type: 'presets', presets });
        break;

      case 'hotkey':
        if (IS_TOP) {
          const preset = presets.find((p) => p.id === msg.presetId);
          if (preset) trigger(preset);
        }
        break;
    }
  });

  /** Demande à la frame porteuse les valeurs actuellement affichées. */
  function requestValues() {
    const requestId = uid();
    return new Promise((resolve) => {
      pendingAbsorb.set(requestId, resolve);
      broadcast({ type: 'absorb', requestId });
      setTimeout(() => {
        if (pendingAbsorb.delete(requestId)) resolve(null);
      }, 1200);
    });
  }

  /** Déclenche une combinaison depuis n'importe quelle frame. */
  function trigger(preset) {
    claimed = false;
    broadcast({ type: 'run', preset });
    setTimeout(() => {
      if (!claimed) toast('Champs introuvables — ouvre l\'éditeur d\'appel', 'error');
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Raccourcis
  // ---------------------------------------------------------------------------

  const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta'];

  function describeHotkey(h) {
    if (!h) return 'aucun';
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
      !!h &&
      event.key.toLowerCase() === h.key &&
      event.ctrlKey === !!h.ctrlKey &&
      event.shiftKey === !!h.shiftKey &&
      event.altKey === !!h.altKey &&
      event.metaKey === !!h.metaKey
    );
  }

  let recording = null;

  /**
   * Écoute la prochaine combinaison. `onLive` reçoit le texte à afficher au fur
   * et à mesure que les modificateurs sont enfoncés, `onDone` la combinaison
   * retenue (ou null si annulée).
   */
  function recordHotkey(onLive, onDone) {
    if (recording) recording.cancel();

    const held = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    const paint = (tail) => onLive(describeHotkey({ ...held, key: tail }));

    const stop = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      recording = null;
    };

    const sync = (event) => {
      held.ctrlKey = event.ctrlKey;
      held.shiftKey = event.shiftKey;
      held.altKey = event.altKey;
      held.metaKey = event.metaKey;
    };

    function onKeyUp(event) {
      sync(event);
      paint('…');
    }

    function onKeyDown(event) {
      event.preventDefault();
      event.stopPropagation();
      sync(event);

      if (MODIFIER_KEYS.includes(event.key)) { paint('…'); return; }

      if (event.key === 'Escape') { stop(); onDone(null); return; }

      // Une touche nue se déclencherait en tapant une note d'appel.
      if (!held.ctrlKey && !held.altKey && !held.metaKey) {
        paint(event.key.toUpperCase());
        onLive('Ajoute Ctrl, Alt ou Cmd');
        return;
      }

      stop();
      onDone({ key: event.key.toLowerCase(), ...held });
    }

    recording = { cancel: () => { stop(); onDone(null); } };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    paint('…');
  }

  // Écouté dans chaque frame : le focus clavier peut être dans le widget d'appel.
  document.addEventListener('keydown', (event) => {
    if (recording) return; // on est en train d'enregistrer, pas de déclencher
    const hit = presets.find((p) => matchesHotkey(event, p.hotkey));
    if (!hit) return;
    event.preventDefault();
    if (IS_TOP) trigger(hit); else toTop({ type: 'hotkey', presetId: hit.id });
  }, true);

  // ---------------------------------------------------------------------------
  // Interface — frame principale uniquement
  // ---------------------------------------------------------------------------

  const COLORS = { pending: '#516f90', success: '#00a4bd', error: '#f2545b' };
  const ORANGE = '#ff7a59';
  const SLATE = '#516f90';

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
      boxShadow: '0 2px 12px rgba(0,0,0,.25)', whiteSpace: 'nowrap',
    });
    button.addEventListener('click', onClick);
    return button;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Emoji écarté : U+1F441 (œil) n'existe pas dans toutes les polices système et
  // s'affiche alors en carré vide. Un tracé ne dépend d'aucune police.
  const EYE = [
    'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z',
    'M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  ];
  const EYE_OFF = EYE.concat('M2.5 13.5 13.5 2.5');

  /** Construit l'icône par DOM plutôt que par innerHTML (Trusted Types). */
  function svgIcon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function makeSmallButton(label, onClick, title) {
    const button = document.createElement('button');
    button.textContent = label;
    if (title) button.title = title;
    Object.assign(button.style, {
      padding: '5px 9px', borderRadius: '4px', cursor: 'pointer',
      border: '1px solid #cbd6e2', background: '#fff', color: '#33475b',
      font: '500 12px/1 system-ui, sans-serif', whiteSpace: 'nowrap',
    });
    button.addEventListener('click', onClick);
    return button;
  }

  /** Boutons discrets au repos, pleins au survol. */
  function dim(button) {
    button.style.opacity = String(CONFIG.buttonOpacity);
    button.style.transition = 'opacity .15s';
    button.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
    button.addEventListener('mouseleave', () => { button.style.opacity = String(CONFIG.buttonOpacity); });
    return button;
  }

  let bar = null;

  function renderButtons() {
    if (!IS_TOP || !CONFIG.showButtons) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'lazyq-bar';
      Object.assign(bar.style, {
        position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483646',
        display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
        justifyContent: 'flex-end', maxWidth: 'min(640px, 70vw)',
      });
      document.body.appendChild(bar);
    }
    bar.textContent = '';
    for (const preset of presets.filter((p) => p.visible)) {
      bar.appendChild(dim(makeButton(
        preset.label, ORANGE, () => trigger(preset),
        preset.hotkey ? `Raccourci : ${describeHotkey(preset.hotkey)}` : 'Aucun raccourci',
      )));
    }
    bar.appendChild(dim(makeButton('⚙️', SLATE, toggleSettings, 'Combinaisons')));
  }

  // ---------------------------------------------------------------------------
  // Panneau de réglages
  // ---------------------------------------------------------------------------

  let settingsEl = null;

  function toggleSettings() {
    if (settingsEl) { closeSettings(); return; }
    settingsEl = document.createElement('div');
    Object.assign(settingsEl.style, {
      position: 'fixed', bottom: '76px', right: '20px', zIndex: '2147483647',
      width: 'min(420px, 92vw)', maxHeight: '70vh', overflowY: 'auto',
      background: '#fff', borderRadius: '8px', border: '1px solid #cbd6e2',
      boxShadow: '0 4px 24px rgba(0,0,0,.25)', padding: '14px',
      font: '13px/1.4 system-ui, sans-serif', color: '#33475b',
      display: 'flex', flexDirection: 'column', gap: '10px',
    });
    document.body.appendChild(settingsEl);
    renderSettings();
  }

  function closeSettings() {
    if (recording) recording.cancel();
    if (settingsEl) settingsEl.remove();
    settingsEl = null;
  }

  /** Résumé lisible des valeurs d'une combinaison. */
  function summarize(values) {
    const parts = Object.entries(values).map(([name, value]) => `${name} : ${value}`);
    return parts.length ? parts.join(' · ') : 'aucune valeur — utilise Absorber';
  }

  function renderSettings() {
    if (!settingsEl) return;
    settingsEl.textContent = '';

    const title = document.createElement('strong');
    title.textContent = 'Combinaisons';
    settingsEl.appendChild(title);

    const help = document.createElement('div');
    help.textContent = 'Absorber copie ce qui est actuellement posé sur l\'appel ouvert.';
    Object.assign(help.style, { color: '#7c98b6', fontSize: '12px' });
    settingsEl.appendChild(help);

    for (const preset of presets) settingsEl.appendChild(renderPresetRow(preset));

    const add = makeSmallButton('+ Ajouter depuis l\'appel courant', async () => {
      const values = await requestValues();
      if (!values) { toast('Aucun champ lisible — ouvre l\'éditeur d\'appel', 'error'); return; }
      presets.push({
        id: uid(),
        label: Object.values(values).join(' / ') || 'Nouvelle combinaison',
        hotkey: null,
        visible: false, // l'œil la fait apparaître en bas de page
        autoASR: false,
        values,
      });
      savePresets();
      toast('Combinaison ajoutée — donne-lui un raccourci, puis l\'œil pour l\'afficher', 'success');
    });
    Object.assign(add.style, { alignSelf: 'flex-start', marginTop: '4px' });
    settingsEl.appendChild(add);

    const close = makeSmallButton('Fermer', closeSettings);
    Object.assign(close.style, { alignSelf: 'flex-end' });
    settingsEl.appendChild(close);
  }

  function renderPresetRow(preset) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      border: '1px solid #dfe3eb', borderRadius: '6px', padding: '10px',
      display: 'flex', flexDirection: 'column', gap: '8px', background: '#f5f8fa',
    });

    const name = document.createElement('input');
    name.value = preset.label;
    Object.assign(name.style, {
      border: '1px solid #cbd6e2', borderRadius: '4px', padding: '6px 8px',
      font: '600 13px/1 system-ui, sans-serif', color: '#33475b', width: '100%',
      boxSizing: 'border-box',
    });
    name.addEventListener('change', () => {
      preset.label = name.value.trim() || preset.label;
      savePresets();
    });

    const values = document.createElement('div');
    values.textContent = summarize(preset.values);
    Object.assign(values.style, { color: '#516f90', fontSize: '12px', wordBreak: 'break-word' });

    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });

    // Bouton-raccourci : affiche la combinaison, et l'enregistre au clic en
    // montrant les modificateurs au fur et à mesure qu'ils sont enfoncés.
    const hotkeyBtn = makeSmallButton(describeHotkey(preset.hotkey), () => {
      hotkeyBtn.style.borderColor = ORANGE;
      hotkeyBtn.style.color = ORANGE;
      recordHotkey(
        (live) => { hotkeyBtn.textContent = live; },
        (next) => {
          hotkeyBtn.style.borderColor = '#cbd6e2';
          hotkeyBtn.style.color = '#33475b';
          if (!next) { hotkeyBtn.textContent = describeHotkey(preset.hotkey); return; }
          const clash = presets.find((p) => p !== preset && matchesHotkeyPair(p.hotkey, next));
          if (clash) {
            hotkeyBtn.textContent = describeHotkey(preset.hotkey);
            toast(`${describeHotkey(next)} est déjà pris par « ${clash.label} »`, 'error');
            return;
          }
          preset.hotkey = next;
          savePresets();
          toast(`${preset.label} : ${describeHotkey(next)}`, 'success');
        },
      );
    }, 'Cliquer puis taper la combinaison');

    const eye = makeSmallButton('', () => setPresetVisible(preset, !preset.visible),
      'Afficher ou masquer son bouton en bas de page');
    Object.assign(eye.style, { display: 'flex', alignItems: 'center', padding: '5px 8px' });
    paintEye(eye, preset.visible);

    const absorb = makeSmallButton('Absorber', async () => {
      const current = await requestValues();
      if (!current) { toast('Aucun champ lisible — ouvre l\'éditeur d\'appel', 'error'); return; }
      preset.values = current;
      savePresets();
      toast(`${preset.label} mis à jour`, 'success');
    }, 'Copier les valeurs de l\'appel ouvert dans cette combinaison');

    const asr = document.createElement('label');
    Object.assign(asr.style, {
      display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
      font: '500 12px/1 var(--body)', color: '#33475b', padding: '5px 9px',
      border: '1px solid ' + (preset.autoASR ? ORANGE : '#cbd6e2'),
      borderRadius: '4px', background: '#fff', whiteSpace: 'nowrap',
    });
    asr.title = "Si l'appel précédent vise le même numéro et porte déjà cette "
      + "combinaison, faire monter « " + CONFIG.asrField.name + " » d'un cran";
    const asrBox = document.createElement('input');
    asrBox.type = 'checkbox';
    asrBox.checked = preset.autoASR === true;
    asrBox.style.margin = '0';
    asrBox.addEventListener('change', () => setPresetAutoASR(preset, asrBox.checked));
    asr.append(asrBox, document.createTextNode('Auto ASR'));

    const remove = makeSmallButton('Supprimer', () => {
      presets = presets.filter((p) => p !== preset);
      if (!presets.length) presets = JSON.parse(JSON.stringify(CONFIG.defaultPresets));
      savePresets();
    });
    remove.style.color = COLORS.error;

    actions.append(eye, hotkeyBtn, absorb, asr, remove);
    row.append(name, values, actions);
    return row;
  }

  function paintEye(button, visible) {
    button.textContent = '';
    button.appendChild(svgIcon(visible ? EYE : EYE_OFF));
    button.style.color = visible ? ORANGE : '#7c98b6';
    button.style.borderColor = visible ? ORANGE : '#cbd6e2';
  }

  function setPresetVisible(preset, visible) {
    preset.visible = visible;
    savePresets();
  }

  function setPresetAutoASR(preset, enabled) {
    preset.autoASR = enabled;
    savePresets();
  }

  function matchesHotkeyPair(a, b) {
    if (!a || !b) return false;
    return a.key === b.key && !!a.ctrlKey === !!b.ctrlKey && !!a.shiftKey === !!b.shiftKey
      && !!a.altKey === !!b.altKey && !!a.metaKey === !!b.metaKey;
  }

  // ---------------------------------------------------------------------------
  // Mode sonde — diagnostic, sans bouton ni raccourci
  //
  // Ne sert que le jour où le ciblage casse : lazyQ.probe() depuis la
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

    for (const field of CONFIG.fields.concat(CONFIG.asrField)) {
      const labels = findLabelNodes(field.labels);
      lines.push(`Champ « ${field.name} » — ${labels.length} libellé(s)`);
      labels.slice(0, 5).forEach((l) => lines.push(`    libellé ${describe(l)}`));
      const found = findTrigger(field.labels);
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

    lines.push('', timelineText());
    return lines.join('\n');
  }

  /** Ce qu'il faut savoir pour cibler « le dernier appel » et « l'appel d'avant ». */
  function timelineText() {
    const lines = ['--- CHRONOLOGIE ---'];

    for (const selector of CONFIG.timeline.cardSelectors.concat(CONFIG.timeline.eventAnchors)) {
      let raw = [];
      try { raw = [...document.querySelectorAll(selector)]; } catch (_) { /* sélecteur refusé */ }
      lines.push(`Sélecteur ${selector} — ${raw.length} élément(s) bruts`);
    }

    const cards = findCallCards();
    lines.push(`Cartes d'appel retenues : ${cards.length}`);

    cards.slice(0, 6).forEach((card, index) => {
      const info = cardInfo(card);
      lines.push(`  Carte ${index + 1} ${nodeSignature(card)}`);
      lines.push(`    date lue : ${cardDate(info.text) ? new Date(cardDate(info.text)).toISOString() : 'AUCUNE'}`);
      lines.push(`    téléphones détectés : ${info.phones.join(', ') || 'AUCUN'}`);
      lines.push(`    texte : "${info.text.slice(0, 220)}"`);
    });

    // Informatif seulement : la qualification appartenant au contact, ces
    // comparaisons ne gouvernent plus l'escalade. Elles restent utiles pour
    // vérifier qu'on parle bien du bon appel précédent.
    if (cards.length >= 2) {
      const last = cardInfo(cards[0]);
      const previous = cardInfo(cards[1]);
      lines.push(`Même numéro entre les deux dernières cartes : ${samePhone(last, previous) ? 'OUI' : 'NON'}`);
      for (const preset of presets) {
        lines.push(`  « ${preset.label} » — carte 1 correspond : ${cardMatchesPreset(last, preset) ? 'OUI' : 'NON'}`
          + ` / carte 2 correspond : ${cardMatchesPreset(previous, preset) ? 'OUI' : 'NON'}`);
      }
    }

    const asr = findPropertyControl(CONFIG.asrField.labels);
    lines.push(`Propriété « ${CONFIG.asrField.name} » : ${asr ? nodeSignature(asr) : 'INTROUVABLE'}`);
    if (asr) {
      const current = readPropertyValue(asr);
      lines.push(`    valeur actuelle = "${current}"`);
      lines.push(`    prochaine valeur = "${asrTarget(current)}"`);
    }

    return lines.join('\n');
  }

  /**
   * Ouvre le menu d'un champ et liste ses options réelles, puis referme.
   * Contrairement au reste de la sonde, cet appel touche à l'interface : il est
   * donc explicite et jamais déclenché tout seul.
   */
  async function probeOptions(labels) {
    const names = Array.isArray(labels) ? labels : [labels];

    // Une propriété différée n'a pas de menu tant qu'elle n'est pas activée :
    // elle a son propre chemin, sinon la sonde ne verrait jamais ses options.
    const property = findPropertyControl(names);
    const before = new Set(optionNodes(true));

    let trigger = null;
    if (property) {
      await enterEditMode({ labels: names }, property);
      trigger = propertyTrigger({ labels: names }, property);
    } else {
      const found = findTrigger(names);
      trigger = found && found.trigger;
    }
    if (!trigger) { showReport(`Champ introuvable ou non activable : ${names.join(' / ')}`); return; }

    const found = { trigger };
    realClick(trigger);
    await sleep(600);

    const fresh = optionNodes(true).filter((el) => !before.has(el));
    const lines = [
      `--- OPTIONS de ${names[0]} ---`,
      `déclencheur = ${describe(found.trigger)}`,
      `valeur actuelle = "${readValue(found.trigger).trim()}"`,
      `${fresh.length} option(s) apparues :`,
      ...fresh.slice(0, 60).map((o) => `    "${(o.textContent || '').trim().replace(/\s+/g, ' ')}"`),
    ];

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    console.log('[LazyQ] ' + lines.join('\n'));
    showReport(lines.join('\n'));
  }

  /** Signature lisible d'un noeud : ce qui sert à écrire un sélecteur. */
  function nodeSignature(el) {
    const classes = ((el.className && el.className.toString()) || '')
      .trim().split(/\s+/).filter(Boolean).slice(0, 3)
      .map((c) => '.' + c.slice(0, 34)).join('');
    const attrs = [...el.attributes]
      .filter((a) => a.name.startsWith('data-') || a.name === 'role' || a.name === 'aria-label')
      .map((a) => `${a.name}="${a.value.slice(0, 44)}"`)
      .join(' ');
    // Balise, id et classes collés comme un sélecteur CSS ; attributs à la suite.
    const selector = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + classes;
    return attrs ? `${selector} ${attrs}` : selector;
  }

  /** Combien de frères partagent la même signature : révèle le niveau répété. */
  function similarSiblings(el) {
    const parent = el.parentElement;
    if (!parent) return 0;
    const key = (n) => n.tagName + '|' + ((n.className && n.className.toString()) || '').slice(0, 60);
    const mine = key(el);
    return [...parent.children].filter((n) => key(n) === mine).length;
  }

  /**
   * Part d'un texte visible à l'écran et remonte la chaîne des ancêtres.
   * Plus fiable que deviner des sélecteurs : le niveau qui se répète est celui
   * de la carte, et les attributs remontés donnent de quoi le cibler.
   */
  function probeAnchor(text) {
    const wanted = norm(text);
    let matches = [...document.querySelectorAll('*')]
      .filter((el) => isVisible(el) && norm(el.textContent).includes(wanted));
    // On garde les plus profonds : les ancêtres sont dumpés juste après.
    matches = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));

    const lines = [`--- ANCRE "${text}" (frame ${FRAME}) ---`, `${matches.length} élément(s) au plus profond`];

    matches.slice(0, 3).forEach((el, index) => {
      lines.push('', `#${index + 1} ${nodeSignature(el)}`);
      lines.push(`   texte : "${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)}"`);
      lines.push('   ancêtres :');
      let node = el;
      for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
        const siblings = similarSiblings(node);
        const flag = siblings >= 3 ? '   <-- niveau répété' : '';
        lines.push(`   ${depth} ${nodeSignature(node)}  [frères similaires: ${siblings}]${flag}`);
      }
    });

    const report = lines.join('\n');
    console.log('[LazyQ] ' + report);
    if (IS_TOP) showReport(report); else toTop({ type: 'status', kind: 'pending', text: 'Ancre : voir la console' });
    return report;
  }

  /** Éléments visibles apparus depuis la photo, les plus externes seulement. */
  function newSince(snapshot) {
    const fresh = [...document.querySelectorAll('*')].filter((el) => isVisible(el) && !snapshot.has(el));
    return fresh.filter((el) => !fresh.some((other) => other !== el && other.contains(el)));
  }

  function visibleSnapshot() {
    return new Set([...document.querySelectorAll('*')].filter(isVisible));
  }

  /**
   * Rejoue pas à pas l'écriture de la qualification en rapportant l'état après
   * chaque geste. Deviner deux fois de suite ce qui bloque coûte plus cher que
   * d'instrumenter une fois : cette trace dit où ça casse et ce que la page
   * rend réellement, y compris ce que les sélecteurs d'options ne voient pas.
   */
  async function traceASR() {
    const field = CONFIG.asrField;
    const lines = [`--- TRACE ${field.name} ---`];
    const dump = (label, elements) => {
      lines.push(`   ${label} (${elements.length}) :`);
      elements.slice(0, 30).forEach((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
        lines.push(`      ${nodeSignature(el)} "${text}"`);
      });
    };

    const root = findPropertyControl(field.labels);
    if (!root) { showReport(lines.concat('bloc INTROUVABLE').join('\n')); return; }

    const current = readPropertyValue(root);
    const target = asrTarget(current);
    lines.push(`1. bloc = ${nodeSignature(root)}`);
    lines.push(`   valeur lue = "${current}" → cible "${target}"`);

    // Étape 2 : activation, geste par geste.
    const attempts = [
      ['clic sur le bloc', () => realClick(root)],
      ['touche Entrée', () => {
        if (root.focus) root.focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }],
      ['clic sur la zone de valeur', () => {
        const inner = [...root.children].reverse().find(isVisible);
        if (inner) realClick(inner);
      }],
    ];

    let trigger = propertyTrigger(field, root);
    lines.push(`   mode initial = ${root.getAttribute('data-deferred-property-input-mode')}`);
    lines.push(`   déclencheur avant activation = ${trigger ? nodeSignature(trigger) : 'aucun (attendu en mode display)'}`);
    lines.push('   (le mode actif se nomme « input » pour une liste déroulante)');

    for (const [label, act] of attempts) {
      if (trigger) break;
      const before = visibleSnapshot();
      act();
      await sleep(700);
      const live = findPropertyControl(field.labels) || root;
      lines.push(`2. ${label}`);
      lines.push(`   mode = ${live.getAttribute('data-deferred-property-input-mode')}`);
      dump('nouveaux éléments', newSince(before));
      trigger = propertyTrigger(field, root);
      lines.push(`   déclencheur = ${trigger ? nodeSignature(trigger) : 'AUCUN'}`);
    }

    if (!trigger) { showReport(lines.concat("3. aucun déclencheur : l'activation échoue").join('\n')); return; }

    // Étape 3 : ouverture de la liste, et surtout ce que les sélecteurs voient.
    const before = visibleSnapshot();
    const optionsBefore = new Set(optionNodes(true));
    realClick(trigger);
    await sleep(700);

    const appeared = newSince(before);
    lines.push('3. clic sur le déclencheur');
    dump('nouveaux éléments visibles', appeared);

    const strict = optionNodes(false).filter((el) => !optionsBefore.has(el));
    const broad = optionNodes(true).filter((el) => !optionsBefore.has(el));
    lines.push(`   vus par le sélecteur strict : ${strict.length}`);
    lines.push(`   vus par le sélecteur large  : ${broad.length}`);
    lines.push(`   correspondance « ${target} » : ${matchOption(broad, target) ? 'TROUVÉE' : 'AUCUNE'}`);

    if (!broad.length && appeared.length) {
      lines.push('   → la liste est rendue mais aucun sélecteur ne la voit :');
      lines.push('     coller les signatures ci-dessus suffit à les corriger.');
    }

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const report = lines.join('\n');
    console.log('[LazyQ] ' + report);
    showReport(report);
    return report;
  }

  function probe() {
    probeReports = [];
    broadcast({ type: 'probe' });
    setTimeout(() => {
      const text = probeReports.join('\n\n') || "(aucune frame n'a répondu)";
      window.__lazyQProbe = text;
      console.log('[LazyQ] SONDE\n' + text);
      showReport(text);
    }, 800);
  }

  // Le presse-papier via navigator.clipboard exige une activation utilisateur
  // transitoire : la collecte inter-frames étant asynchrone, le geste a expiré
  // au moment de copier. On affiche donc le rapport déjà sélectionné.
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
    const copy = makeSmallButton('Copier', () => {
      area.focus();
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => { copy.textContent = 'Copié'; }).catch(() => {});
      }
      copy.textContent = ok ? 'Copié' : 'Fais Cmd+C';
    });
    const close = makeSmallButton('Fermer', () => { panelEl.remove(); panelEl = null; });

    row.append(copy, close);
    panelEl.append(title, area, row);
    document.body.appendChild(panelEl);

    area.focus();
    area.select();
  }

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------

  // HubSpot est une SPA : la barre disparaît à chaque navigation interne.
  new MutationObserver(() => {
    if (IS_TOP && bar && !bar.isConnected) { bar = null; renderButtons(); }
  }).observe(document.body, { childList: true, subtree: false });

  if (IS_TOP) renderButtons(); else toTop({ type: 'needPresets' });

  window.lazyQ = {
    probe, probeText, probeOptions, probeAnchor, traceASR, newSince, timelineText, nodeSignature, trigger, runPreset, selectValue, actionsFor, findTrigger,
    findCallCards, cardInfo, cardDate, cardIsOpen, ensureCardOpen, samePhone, cardMatchesPreset,
    enterEditMode, propertyTrigger, isActionsMenu, outermost,
    asrTarget, phonesIn, findPropertyControl, readPropertyValue, setPropertyValue, applyAutoASR,
    optionNodes, readValue, readCurrentValues, hasFieldsFor, recordHotkey,
    describeHotkey, matchesHotkey, savePresets, setPresetVisible, setPresetAutoASR, toggleSettings,
    get presets() { return presets; },
    CONFIG,
  };

  console.info(`[LazyQ] chargé (frame ${FRAME}) — ${presets.length} combinaison(s), lazyQ.probe() pour diagnostiquer`);
})();

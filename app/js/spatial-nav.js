/*
 * Navegacao espacial para controle remoto (setas, OK, Voltar) e Magic Remote (ponteiro).
 * ES5 puro: roda no Chrome 38 (webOS 3) e e carregado no Node pelos testes (module.exports).
 */
(function (global, factory) {
  var api = factory(global);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.SpatialNav = api;
  }
})(this, function (global) {
  'use strict';

  var KEY_LEFT = 37;
  var KEY_UP = 38;
  var KEY_RIGHT = 39;
  var KEY_DOWN = 40;
  var KEY_ENTER = 13;
  var KEY_ESCAPE = 27;
  var KEY_BACK = 461; // botao Voltar do controle LG

  var DIRS = {};
  DIRS[KEY_LEFT] = 'left';
  DIRS[KEY_UP] = 'up';
  DIRS[KEY_RIGHT] = 'right';
  DIRS[KEY_DOWN] = 'down';

  var FOCUSABLE_TAG = 'BUTTON'; // so botoes recebem foco

  var rootEl = null;
  var lastRect = null;
  var ensureTimer = null;

  function center(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function isUsable(candidate) {
    return !!candidate && !!candidate.el && !candidate.el.disabled;
  }

  // Candidato mais proximo no semiplano da direcao: a borda proxima do candidato precisa estar
  // alem do centro da origem (o centro nao muda com o scale do foco).
  // Distancia = deslocamento no eixo da seta + 2x o deslocamento no eixo perpendicular (entre centros).
  function pickNext(fromRect, candidates, dir) {
    var from = center(fromRect);
    var best = null;
    var bestScore = Infinity;
    var i, c, r, to, ahead, primary, secondary, score;

    for (i = 0; i < candidates.length; i++) {
      c = candidates[i];
      if (!isUsable(c)) continue;
      r = c.rect;
      to = center(r);
      if (dir === 'right') {
        ahead = r.left >= from.x;
        primary = to.x - from.x;
        secondary = to.y - from.y;
      } else if (dir === 'left') {
        ahead = r.left + r.width <= from.x;
        primary = from.x - to.x;
        secondary = to.y - from.y;
      } else if (dir === 'down') {
        ahead = r.top >= from.y;
        primary = to.y - from.y;
        secondary = to.x - from.x;
      } else if (dir === 'up') {
        ahead = r.top + r.height <= from.y;
        primary = from.y - to.y;
        secondary = to.x - from.x;
      } else {
        return null;
      }
      if (!ahead) continue;
      score = primary + 2 * Math.abs(secondary);
      if (score < bestScore) {
        bestScore = score;
        best = c.el;
      }
    }
    return best;
  }

  // Candidato habilitado mais proximo em qualquer direcao (|dx| + 2x|dy| entre centros: prefere
  // ficar na mesma linha). Usado para devolver o foco quando o elemento focado fica desabilitado ou some.
  function nearest(fromRect, candidates) {
    var from = center(fromRect);
    var best = null;
    var bestDist = Infinity;
    var i, c, to, dist;

    for (i = 0; i < candidates.length; i++) {
      c = candidates[i];
      if (!isUsable(c)) continue;
      to = center(c.rect);
      dist = Math.abs(to.x - from.x) + 2 * Math.abs(to.y - from.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = c.el;
      }
    }
    return best;
  }

  // --- Parte DOM (so roda no navegador) ---

  function isVisible(el) {
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function isFocusableNode(node) {
    return !!node && node.nodeType === 1 && node.tagName === FOCUSABLE_TAG;
  }

  // Elemento navegavel: botao dentro da raiz, habilitado e visivel.
  function isTarget(el) {
    return !!rootEl && isFocusableNode(el) && rootEl.contains(el) && !el.disabled && isVisible(el);
  }

  function collectCandidates(exclude) {
    var nodes = rootEl.getElementsByTagName(FOCUSABLE_TAG);
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el === exclude || el.disabled || !isVisible(el)) continue;
      list.push({ rect: el.getBoundingClientRect(), el: el });
    }
    return list;
  }

  function focusEl(el) {
    if (!el) return;
    el.focus();
    lastRect = el.getBoundingClientRect();
  }

  // Garante que o foco esteja num elemento navegavel; senao, vai para o mais proximo do ultimo foco.
  function ensureFocus() {
    if (!rootEl) return null;
    var current = global.document.activeElement;
    if (isTarget(current)) {
      lastRect = current.getBoundingClientRect();
      return current;
    }
    var candidates = collectCandidates(null);
    if (!candidates.length) return null;
    var target = lastRect ? nearest(lastRect, candidates) : candidates[0].el;
    focusEl(target);
    return target;
  }

  function scheduleEnsureFocus() {
    if (ensureTimer !== null) return;
    ensureTimer = global.setTimeout(function () {
      ensureTimer = null;
      ensureFocus();
    }, 0);
  }

  function move(dir) {
    var current = global.document.activeElement;
    if (!isTarget(current)) {
      ensureFocus();
      return;
    }
    var next = pickNext(current.getBoundingClientRect(), collectCandidates(current), dir);
    if (next) focusEl(next);
  }

  function closeApp() {
    global.close();
  }

  function onKeyDown(event) {
    var code = event.keyCode;
    if (DIRS[code]) {
      event.preventDefault();
      move(DIRS[code]);
    } else if (code === KEY_ENTER) {
      var current = global.document.activeElement;
      // preventDefault evita o clique nativo do Enter (senao dispararia duas vezes).
      event.preventDefault();
      if (isTarget(current)) current.click();
    } else if (code === KEY_BACK || code === KEY_ESCAPE || event.key === 'Escape') {
      event.preventDefault();
      closeApp();
    }
  }

  function findTarget(node) {
    while (node && node !== rootEl) {
      if (isFocusableNode(node)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function onMouseOver(event) {
    var el = findTarget(event.target);
    if (el && el !== global.document.activeElement && isTarget(el)) focusEl(el);
  }

  function onFocus(event) {
    if (isTarget(event.target)) lastRect = event.target.getBoundingClientRect();
  }

  function watchChanges() {
    var Observer = global.MutationObserver || global.WebKitMutationObserver;
    if (!Observer) return;
    var observer = new Observer(scheduleEnsureFocus);
    observer.observe(rootEl, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'class', 'hidden', 'style']
    });
  }

  function init(root) {
    rootEl = root || global.document.body;
    global.document.addEventListener('keydown', onKeyDown, false);
    rootEl.addEventListener('mouseover', onMouseOver, false);
    rootEl.addEventListener('focus', onFocus, true);
    watchChanges();
  }

  return {
    pickNext: pickNext,
    nearest: nearest,
    init: init,
    ensureFocus: ensureFocus,
    focus: focusEl
  };
});

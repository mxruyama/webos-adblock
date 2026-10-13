'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SpatialNav = require('../app/js/spatial-nav.js');

// Retangulo no formato de getBoundingClientRect (left/top/width/height + right/bottom).
function rect(left, top, width = 100, height = 50) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function cand(id, r, extra) {
  return { rect: r, el: Object.assign({ id, disabled: false }, extra) };
}

test('picks nearest to the right', () => {
  const from = rect(0, 0);
  const far = cand('far', rect(600, 0));
  const near = cand('near', rect(250, 0));
  const middle = cand('middle', rect(400, 0));
  assert.equal(SpatialNav.pickNext(from, [far, near, middle], 'right'), near.el);
});

test('ignores candidates behind', () => {
  const from = rect(500, 500);
  const left = cand('left', rect(380, 500));
  const right = cand('right', rect(900, 500));
  const up = cand('up', rect(500, 420));
  const down = cand('down', rect(500, 800));
  const all = [left, right, up, down];

  assert.equal(SpatialNav.pickNext(from, all, 'right'), right.el);
  assert.equal(SpatialNav.pickNext(from, all, 'left'), left.el);
  assert.equal(SpatialNav.pickNext(from, all, 'up'), up.el);
  assert.equal(SpatialNav.pickNext(from, all, 'down'), down.el);
  // Mesmo centro que a origem nao esta "a frente" em direcao nenhuma.
  assert.equal(SpatialNav.pickNext(from, [cand('same', rect(500, 500))], 'right'), null);
});

test('ignores candidates that start before the origin center', () => {
  // Radio largo (lado direito da tela) e botao abaixo dele cujo centro esta mais a direita:
  // "direita" a partir do radio nao deve descer para o botao.
  const radio = rect(976, 300, 848, 88);
  const buttonBelow = cand('buttonBelow', rect(1286, 700, 538, 104));
  assert.equal(SpatialNav.pickNext(radio, [buttonBelow], 'right'), null);
  // "baixo" continua chegando nele.
  assert.equal(SpatialNav.pickNext(radio, [buttonBelow], 'down'), buttonBelow.el);
});

test('prefers aligned over diagonal', () => {
  const from = rect(0, 0);
  // Diagonal: dx 200, dy 120 -> 200 + 2*120 = 440 (euclidiana ~233 venceria).
  const diagonal = cand('diagonal', rect(200, 120));
  // Alinhado: dx 350, dy 0 -> 350.
  const aligned = cand('aligned', rect(350, 0));
  assert.equal(SpatialNav.pickNext(from, [diagonal, aligned], 'right'), aligned.el);

  // Mesmo criterio no eixo vertical.
  const diagDown = cand('diagDown', rect(150, 200)); // 200 + 2*150 = 500
  const alignedDown = cand('alignedDown', rect(0, 420)); // 420
  assert.equal(SpatialNav.pickNext(from, [diagDown, alignedDown], 'down'), alignedDown.el);
});

test('returns null at edge', () => {
  const from = rect(1700, 900);
  const others = [cand('a', rect(1200, 900)), cand('b', rect(1700, 600)), cand('c', rect(100, 100))];
  assert.equal(SpatialNav.pickNext(from, others, 'right'), null);
  assert.equal(SpatialNav.pickNext(from, others, 'down'), null);
  assert.equal(SpatialNav.pickNext(from, [], 'left'), null);
});

test('skips disabled candidates', () => {
  const from = rect(0, 0);
  const disabled = cand('disabled', rect(200, 0), { disabled: true });
  const enabled = cand('enabled', rect(500, 0));
  assert.equal(SpatialNav.pickNext(from, [disabled, enabled], 'right'), enabled.el);
  assert.equal(SpatialNav.pickNext(from, [disabled], 'right'), null);
});

test('nearest picks the closest enabled candidate, favoring the same row', () => {
  const from = rect(500, 500);
  const disabled = cand('disabled', rect(500, 500), { disabled: true });
  const left = cand('left', rect(240, 500)); // |dx| 260 + 2*0 = 260
  const below = cand('below', rect(500, 650)); // 0 + 2*150 = 300 (euclidiana 150 venceria)
  const farRight = cand('farRight', rect(900, 500)); // 400
  assert.equal(SpatialNav.nearest(from, [disabled, below, farRight, left]), left.el);
  assert.equal(SpatialNav.nearest(from, [disabled, below]), below.el);
  assert.equal(SpatialNav.nearest(from, [disabled]), null);
});

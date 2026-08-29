// Prueft die Peak-Reduktion. Der Rest von peaks.js haengt an WebAudio und
// laesst sich nur im Fenster testen - die Rechnung selbst ist aber genau die
// Stelle, an der ein Fehler still eine falsche Wellenform erzeugt.

import { downsample } from '../src/peaks.js';
import assert from 'node:assert/strict';
import test from 'node:test';

test('nimmt pro Bucket den groessten Ausschlag', () => {
  const channel = Float32Array.from([0.1, 0.9, 0.2, /**/ 0.3, 0.4, 0.5]);
  assert.deepEqual(downsample(channel, 2), [0.9, 0.5]);
});

test('erhaelt das Vorzeichen negativer Ausschlaege', () => {
  // Der eigentliche Punkt: nimmt man nur den Betrag, sieht die Wellenform
  // gleichgerichtet aus - oben und unten identisch, was bei asymmetrischem
  // Material schlicht falsch ist.
  const channel = Float32Array.from([-0.9, 0.2, 0.1, /**/ 0.3, -0.4, 0.2]);
  assert.deepEqual(downsample(channel, 2), [-0.9, -0.4]);
});

test('liefert immer genau so viele Werte wie angefordert', () => {
  for (const [laenge, buckets] of [[1000, 8000], [8000, 8000], [1_000_000, 8000]]) {
    const channel = new Float32Array(laenge).fill(0.5);
    assert.equal(downsample(channel, buckets).length, buckets,
      `Laenge ${laenge} auf ${buckets} Buckets`);
  }
});

test('rundet auf vier Nachkommastellen', () => {
  const channel = Float32Array.from([0.123456789, 0.1]);
  const [value] = downsample(channel, 1);
  assert.equal(value, 0.1235);
});

test('kommt mit Stille klar', () => {
  assert.deepEqual(downsample(new Float32Array(100), 4), [0, 0, 0, 0]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, computeStats } from '../api/_data-analyst.js';

test('parseCSV handles quoted commas and plain rows', () => {
  const csv = 'name,city\n"Doe, John",Cairo\nSara,"New York"';
  const rows = parseCSV(csv);
  assert.deepEqual(rows, [['name', 'city'], ['Doe, John', 'Cairo'], ['Sara', 'New York']]);
});

test('computeStats detects numeric column stats correctly', () => {
  const csv = 'age,city\n10,Cairo\n20,Cairo\n30,Giza\n40,Giza\n1000,Giza';
  const stats = computeStats(csv);
  const age = stats.columns.find(c => c.name === 'age');
  assert.equal(age.type, 'numeric');
  assert.equal(age.min, 10);
  assert.equal(age.max, 1000);
  assert.equal(age.count, 5);
  assert.ok(age.outlierCount >= 1, 'the 1000 value should register as an IQR outlier');
});

test('computeStats detects categorical column with top values', () => {
  const csv = 'age,city\n10,Cairo\n20,Cairo\n30,Giza';
  const stats = computeStats(csv);
  const city = stats.columns.find(c => c.name === 'city');
  assert.equal(city.type, 'categorical');
  assert.equal(city.distinct, 2);
  assert.equal(city.topValues[0].value, 'Cairo');
  assert.equal(city.topValues[0].count, 2);
});

test('computeStats reports missing values per column', () => {
  const csv = 'a,b\n1,\n2,x\n,y';
  const stats = computeStats(csv);
  const a = stats.columns.find(c => c.name === 'a');
  const b = stats.columns.find(c => c.name === 'b');
  assert.equal(a.missing, 1);
  assert.equal(b.missing, 1);
});

test('computeStats computes correlation between two numeric columns', () => {
  const csv = 'x,y\n1,2\n2,4\n3,6\n4,8';
  const stats = computeStats(csv);
  assert.equal(stats.correlations.length, 1);
  assert.ok(Math.abs(stats.correlations[0].r - 1) < 0.001, 'perfectly linear columns should correlate ~1.0');
});

test('computeStats returns an error for an empty file instead of throwing', () => {
  const stats = computeStats('');
  assert.ok(stats.error);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProject, registerDetector, _detectors } from '../api/_project-detect.js';

test('detects a Discord.js bot from package.json dependencies', () => {
  const files = [
    { name: 'package.json', content: JSON.stringify({ dependencies: { 'discord.js': '^14.0.0', mongoose: '^8.0.0' } }) },
    { name: 'index.js', content: 'const { Client } = require("discord.js");' }
  ];
  const result = detectProject(files);
  assert.equal(result.runtime, 'Node.js');
  assert.equal(result.framework, 'discord.js');
  assert.equal(result.type, 'Discord Bot');
  assert.equal(result.database, 'MongoDB');
  assert.ok(result.confidence > 0.5);
});

test('detects a Next.js website and does not misclassify it as plain React', () => {
  const files = [
    { name: 'package.json', content: JSON.stringify({ dependencies: { next: '^14.0.0', react: '^18.0.0', 'react-dom': '^18.0.0' } }) }
  ];
  const result = detectProject(files);
  assert.equal(result.framework, 'Next.js');
  assert.equal(result.type, 'Next.js App');
});

test('detects a Roblox game from Lua structural conventions, not just the .lua extension', () => {
  const files = [
    { name: 'src/init.server.lua', content: 'local Players = game:GetService("Players")' },
    { name: 'src/PlayerHandler.lua', content: 'workspace.ChildAdded:Connect(function() end)' }
  ];
  const result = detectProject(files);
  assert.equal(result.language, 'Lua');
  assert.equal(result.runtime, 'Roblox');
  assert.equal(result.type, 'Roblox Game');
});

test('a plain Lua script without Roblox conventions is not misclassified as Roblox', () => {
  const files = [{ name: 'script.lua', content: 'print("hello world")' }];
  const result = detectProject(files);
  assert.equal(result.language, 'Lua');
  assert.notEqual(result.type, 'Roblox Game');
});

test('detects a Python FastAPI service and pytest', () => {
  const files = [
    { name: 'requirements.txt', content: 'fastapi==0.110.0\npytest==8.0.0\npsycopg2-binary==2.9.9' },
    { name: 'main.py', content: 'from fastapi import FastAPI' }
  ];
  const result = detectProject(files);
  assert.equal(result.language, 'Python');
  assert.equal(result.framework, 'FastAPI');
  assert.equal(result.testFramework, 'pytest');
  assert.equal(result.database, 'PostgreSQL');
});

test('detects a Go project from go.mod', () => {
  const files = [{ name: 'go.mod', content: 'module github.com/example/api\n\ngo 1.22' }];
  const result = detectProject(files);
  assert.equal(result.language, 'Go');
  assert.equal(result.buildSystem, 'go build');
});

test('returns a low-confidence empty-ish result for an unrecognized project instead of guessing', () => {
  const files = [{ name: 'notes.txt', content: 'just some notes' }];
  const result = detectProject(files);
  assert.equal(result.language, null);
  assert.equal(result.confidence, 0);
});

test('an empty file list never throws and reports zero confidence', () => {
  const result = detectProject([]);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.matchedDetectors, []);
});

test('a single bad/throwing detector does not prevent the others from matching', () => {
  registerDetector({ id: 'always-throws-test-only', detect() { throw new Error('boom'); } });
  const files = [{ name: 'go.mod', content: 'module test\n\ngo 1.22' }];
  const result = detectProject(files);
  assert.equal(result.language, 'Go');
  // clean up so this test-only detector doesn't leak into other test files
  const idx = _detectors.findIndex(d => d.id === 'always-throws-test-only');
  if (idx !== -1) _detectors.splice(idx, 1);
});

test('registerDetector is idempotent for the same id', () => {
  const before = _detectors.length;
  const det = { id: 'idempotent-test-only', detect: () => null };
  registerDetector(det);
  registerDetector(det);
  assert.equal(_detectors.length, before + 1);
  const idx = _detectors.findIndex(d => d.id === 'idempotent-test-only');
  _detectors.splice(idx, 1);
});

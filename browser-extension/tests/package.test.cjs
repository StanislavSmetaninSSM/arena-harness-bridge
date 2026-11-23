const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Chrome can load the popup, worker and Arena-only content script', () => {
  const root = path.join(__dirname, '..');
  const file = path.join(root, 'manifest.json');
  assert.ok(fs.existsSync(file), 'loadable extension manifest');
  const manifest = JSON.parse(fs.readFileSync(file));
  assert.equal(manifest.manifest_version, 3);
  for (const script of manifest.content_scripts)
    assert.deepEqual(script.matches.sort(), ['https://arena.ai/*', 'https://www.arena.ai/*']);
  assert.deepEqual(manifest.content_scripts.filter(script=>script.world==='MAIN').flatMap(script=>script.js), ['raw-reply.js']);
  assert.equal(manifest.content_scripts.find(script=>script.world==='MAIN').run_at,'document_start');
  assert.deepEqual(manifest.host_permissions.sort(), ['http://127.0.0.1:8766/*', 'https://arena.ai/*', 'https://www.arena.ai/*']);
  for (const entry of [manifest.action.default_popup, manifest.background.service_worker, ...manifest.content_scripts.flatMap(script=>script.js)]) {
    assert.ok(fs.existsSync(path.join(root, entry)), entry);
  }
});

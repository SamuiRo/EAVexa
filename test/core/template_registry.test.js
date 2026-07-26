import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import TemplateRegistry from '../../src/core/template_registry.js';
import { RenderError } from '../../src/core/errors.js';

async function make_template_dir(root, name, { manifest, html } = {}) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });

  if (html !== undefined) {
    await writeFile(path.join(dir, 'template.html'), html, 'utf-8');
  }

  if (manifest !== undefined) {
    await writeFile(path.join(dir, 'template.json'), JSON.stringify(manifest), 'utf-8');
  }

  return dir;
}

test('resolve() reads an explicit template.json manifest', async () => {
  const builtin_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-registry-builtin-'));

  try {
    await make_template_dir(builtin_dir, 'promo', {
      html: '<html><body>{{TITLE}}</body></html>',
      manifest: { name: 'promo', entry: 'template.html', vars: [{ name: 'TITLE', required: true }] },
    });

    const registry = new TemplateRegistry({ builtin_dir, user_dir: null });
    const resolved = await registry.resolve('promo');

    assert.equal(resolved.manifest.inferred, false);
    assert.equal(resolved.source, 'builtin');
    assert.equal(resolved.manifest.vars[0].name, 'TITLE');
  } finally {
    await rm(builtin_dir, { recursive: true, force: true });
  }
});

test('resolve() infers a manifest when template.json is missing', async () => {
  const builtin_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-registry-builtin-'));

  try {
    await make_template_dir(builtin_dir, 'inferred_tpl', { html: '<html><body>{{A}} {{{B}}}</body></html>' });

    const registry = new TemplateRegistry({ builtin_dir, user_dir: null });
    const resolved = await registry.resolve('inferred_tpl');

    assert.equal(resolved.manifest.inferred, true);
    const names = resolved.manifest.vars.map(v => v.name).sort();
    assert.deepEqual(names, ['A', 'B']);
  } finally {
    await rm(builtin_dir, { recursive: true, force: true });
  }
});

test('user_dir overrides builtin_dir for the same template name', async () => {
  const builtin_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-registry-builtin-'));
  const user_dir    = await mkdtemp(path.join(tmpdir(), 'eavexa-registry-user-'));

  try {
    await make_template_dir(builtin_dir, 'shared_name', { html: '<html>builtin</html>' });
    await make_template_dir(user_dir, 'shared_name', { html: '<html>user</html>' });

    const registry = new TemplateRegistry({ builtin_dir, user_dir });
    const resolved = await registry.resolve('shared_name');

    assert.equal(resolved.source, 'user');
  } finally {
    await rm(builtin_dir, { recursive: true, force: true });
    await rm(user_dir, { recursive: true, force: true });
  }
});

test('resolve() throws TEMPLATE_NOT_FOUND for a missing template', async () => {
  const registry = new TemplateRegistry({ builtin_dir: null, user_dir: null });

  await assert.rejects(() => registry.resolve('does_not_exist'), error => {
    assert.ok(error instanceof RenderError);
    assert.equal(error.code, 'TEMPLATE_NOT_FOUND');
    return true;
  });
});

test('resolve() rejects a path-traversal-looking template name', async () => {
  const registry = new TemplateRegistry({ builtin_dir: null, user_dir: null });

  await assert.rejects(() => registry.resolve('../../etc'), error => {
    assert.ok(error instanceof RenderError);
    assert.equal(error.code, 'INVALID_REQUEST');
    return true;
  });
});

test('read_html() returns the entry file contents', async () => {
  const builtin_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-registry-builtin-'));

  try {
    await make_template_dir(builtin_dir, 'html_read', { html: '<html>hi</html>' });

    const registry = new TemplateRegistry({ builtin_dir, user_dir: null });
    assert.equal(await registry.read_html('html_read'), '<html>hi</html>');
  } finally {
    await rm(builtin_dir, { recursive: true, force: true });
  }
});

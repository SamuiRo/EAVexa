import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escape_html,
  apply_vars,
  inject_base_url,
  inject_font_preloads,
} from '../src/shared/html_template.js';

test('escape_html escapes all five special characters (B3)', () => {
  assert.equal(escape_html(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;');
});

test('apply_vars escapes {{KEY}} but inserts {{{KEY}}} raw (B3)', () => {
  const html = '<h1>{{TITLE}}</h1><div>{{{BODY}}}</div>';
  const out = apply_vars(html, {
    TITLE: '<script>alert(1)</script>',
    BODY: '<b>bold</b>',
  });

  assert.equal(
    out,
    '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1><div><b>bold</b></div>',
  );
});

test('apply_vars leaves unknown placeholders untouched', () => {
  assert.equal(apply_vars('{{KNOWN}} {{UNKNOWN}}', { KNOWN: 'x' }), 'x {{UNKNOWN}}');
});

test('inject_base_url adds a <base> tag into <head> (B2)', () => {
  const html = '<html><head><title>t</title></head><body></body></html>';
  const out  = inject_base_url(html, 'file:///C:/tpl/');

  assert.match(out, /<base href="file:\/\/\/C:\/tpl\/">/);
});

test('inject_base_url is a no-op when a <base> tag already exists', () => {
  const html = '<html><head><base href="x"></head></html>';
  assert.equal(inject_base_url(html, 'file:///y'), html);
});

test('inject_font_preloads adds preload links before </head>', () => {
  const html = '<html><head></head></html>';
  const out  = inject_font_preloads(html, ['https://fonts.example/a.css']);

  assert.match(out, /<link rel="preload" href="https:\/\/fonts\.example\/a\.css"/);
});

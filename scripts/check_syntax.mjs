import { readdir } from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec_file = promisify(execFile);
const ROOTS = ['src', 'test'];

// ─── Zero-dependency syntax check ────────────────────────────────────────────
// This project has no ESLint config yet (see docs/specification.md §16 Крок 6);
// `node --check` over every source/test file is the fast, dependency-free gate
// that runs before the full test suite, cross-platform (no shell find/xargs).

async function collect_js_files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full_path = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collect_js_files(full_path));
    } else if (entry.name.endsWith('.js')) {
      files.push(full_path);
    }
  }

  return files;
}

async function main() {
  const files = (await Promise.all(ROOTS.map(collect_js_files))).flat();
  let failures = 0;

  for (const file of files) {
    try {
      await exec_file(process.execPath, ['--check', file]);
    } catch (error) {
      failures += 1;
      console.error(`✕ ${file}\n${error.stderr || error.message}`);
    }
  }

  console.log(`Checked ${files.length} file(s), ${failures} failure(s).`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();

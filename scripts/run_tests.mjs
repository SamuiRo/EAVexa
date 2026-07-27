import { readdir } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

// ─── Zero-dependency test runner ─────────────────────────────────────────────
// `node --test` only expands glob patterns from Node 22 on. On Node 18 and 20 —
// both in the supported range (`engines.node: ">=18"`) and in the CI matrix — a
// pattern is taken as a literal path and the run dies with
// `Could not find '<cwd>/test/**/*.test.js'`. Collecting the files here and
// handing `node --test` explicit paths keeps `npm test` identical on every
// supported runtime, and on Windows, where no shell expands the glob either.

const TEST_ROOT   = 'test';
const TEST_SUFFIX = '.test.js';

async function collect_test_files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files   = [];

  for (const entry of entries) {
    const full_path = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collect_test_files(full_path));
    } else if (entry.name.endsWith(TEST_SUFFIX)) {
      files.push(full_path);
    }
  }

  return files;
}

async function run_node_test(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });

    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function main() {
  try {
    // Sorted so a failure reproduces in the same order everywhere.
    const files = (await collect_test_files(TEST_ROOT)).sort();

    if (files.length === 0) {
      console.error(`No ${TEST_SUFFIX} files found under ${TEST_ROOT}/`);
      process.exitCode = 1;
      return;
    }

    process.exitCode = await run_node_test(files);
  } catch (error) {
    console.error(`Test run failed: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();

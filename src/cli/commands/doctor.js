import { existsSync } from 'fs';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { chromium } from 'playwright';
import ffmpeg_static_path from 'ffmpeg-static';
import { parse_args } from '../args.js';
import { create_output } from '../output.js';
import TemplateRegistry from '../../core/template_registry.js';
import {
  CHROME_PATH, FFMPEG_PATH, TMP_DIR, OUTPUT_DIR, TEMPLATES_DIR, BUILTIN_TEMPLATES_DIR,
} from '../../config/app_config.js';

const exec_file = promisify(execFile);
const BOOLEANS = ['json', 'help'];
const ALIASES = { h: 'help' };

const HELP = `Usage: eavexa doctor [options]

Check that Chromium, FFmpeg, and the configured directories are usable.
Exits with code 4 if any check fails.

Options:
      --json    Print machine-readable JSON instead of a human table`;

export default async function doctor_command(argv) {
  const args = parse_args(argv, { aliases: ALIASES, booleans: BOOLEANS });

  if (args.help) {
    console.log(HELP);
    return;
  }

  const output = create_output({ json: !!args.json });
  const checks = await run_checks();
  const ok = checks.every(check => check.ok);

  if (output.json) {
    output.result({ ok, checks });
  } else {
    for (const check of checks) {
      const status = check.ok ? 'OK  ' : 'FAIL';
      output[check.ok ? 'success' : 'warn'](`${status}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
  }

  if (!ok) process.exitCode = 4;
}

async function run_checks() {
  return [
    check_node_version(),
    check_chromium(),
    ...(await check_ffmpeg_and_codecs()),
    await check_writable('TMP_DIR', TMP_DIR),
    await check_writable('OUTPUT_DIR', OUTPUT_DIR),
    ...(await check_templates()),
  ];
}

async function check_templates() {
  const builtin_exists = existsSync(BUILTIN_TEMPLATES_DIR);
  const user_exists = existsSync(TEMPLATES_DIR);

  const checks = [
    {
      name: 'BUILTIN_TEMPLATES_DIR',
      ok: builtin_exists,
      detail: builtin_exists ? BUILTIN_TEMPLATES_DIR : `not found at ${BUILTIN_TEMPLATES_DIR}`,
    },
    {
      // Missing is normal — a user template dir is optional — so this never fails the check.
      name: 'TEMPLATES_DIR (user)',
      ok: true,
      detail: user_exists ? TEMPLATES_DIR : `not set — ${TEMPLATES_DIR} does not exist (optional)`,
    },
  ];

  const registry = new TemplateRegistry({ builtin_dir: BUILTIN_TEMPLATES_DIR, user_dir: TEMPLATES_DIR });
  const templates = await registry.list().catch(() => []);

  checks.push({
    name: 'Templates in registry',
    ok: templates.length > 0,
    detail: templates.length > 0
      ? `${templates.length} found: ${templates.map(t => t.name).join(', ')}`
      : 'none found — renders by template name will fail',
  });

  return checks;
}

function check_node_version() {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= 18;
  return { name: `Node.js ${process.version}`, ok, detail: ok ? null : 'EAVexa requires Node 18 or newer' };
}

function check_chromium() {
  const resolved = CHROME_PATH ?? chromium.executablePath();
  const ok = existsSync(resolved);
  return { name: 'Chromium', ok, detail: ok ? resolved : `not found at ${resolved}` };
}

async function check_ffmpeg_and_codecs() {
  const resolved = FFMPEG_PATH ?? ffmpeg_static_path ?? 'ffmpeg';

  if (FFMPEG_PATH || ffmpeg_static_path) {
    if (!existsSync(resolved)) {
      return [{ name: 'FFmpeg', ok: false, detail: `not found at ${resolved}` }];
    }
  }

  try {
    const { stdout } = await exec_file(resolved, ['-hide_banner', '-codecs'], { timeout: 10000 });

    return [
      { name: 'FFmpeg', ok: true, detail: resolved },
      { name: 'FFmpeg codec libx264', ok: stdout.includes('libx264') },
      { name: 'FFmpeg codec libvpx-vp9', ok: stdout.includes('libvpx-vp9') },
    ];
  } catch (error) {
    return [{ name: 'FFmpeg', ok: false, detail: `${resolved}: ${error.message}` }];
  }
}

async function check_writable(name, dir) {
  try {
    await mkdir(dir, { recursive: true });

    const probe = path.join(dir, `.eavexa_doctor_${Date.now()}`);
    await writeFile(probe, 'ok');
    await unlink(probe);

    return { name: `${name} writable`, ok: true, detail: dir };
  } catch (error) {
    return { name: `${name} writable`, ok: false, detail: `${dir}: ${error.message}` };
  }
}

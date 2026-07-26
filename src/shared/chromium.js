import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { CHROME_SANDBOX } from '../config/app_config.js';
import { log } from './logger.js';

// ─── Chromium launch helpers ─────────────────────────────────────────────────

const BASE_ARGS = [
  '--font-render-hinting=none',   // consistent font rendering across OSes
  '--disable-lcd-text',           // disable sub-pixel AA for pixel-perfect output
  '--force-color-profile=srgb',   // always sRGB
];

function is_containerized() {
  return existsSync('/.dockerenv');
}

function should_disable_sandbox() {
  if (CHROME_SANDBOX === 'off') return true;
  if (CHROME_SANDBOX === 'on') return false;

  return is_containerized(); // 'auto' — only inside a container
}

/**
 * Build Chromium launch args. `--no-sandbox` is added only when
 * CHROME_SANDBOX=off, or CHROME_SANDBOX=auto (default) and a container is
 * detected — never as the unconditional default on a bare-metal host.
 */
export function build_launch_args() {
  const args = [...BASE_ARGS];

  if (should_disable_sandbox()) {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }

  return args;
}

/**
 * Resolve the executablePath option for chromium.launch(), or undefined to
 * let Playwright use its own bundled Chromium.
 */
export function resolve_executable_path(chrome_path) {
  return chrome_path && existsSync(chrome_path) ? chrome_path : undefined;
}

/**
 * Chromium refuses to load local file:// subresources (images, video, fonts)
 * from a document that was populated via page.setContent() — its URL stays
 * "about:blank", and a `<base href="file://...">` tag does not change that,
 * so every relative asset a template references fails with "Not allowed to
 * load local resource". Navigating to the template's own directory first
 * gives the page a real file:// document URL; setContent() afterward keeps
 * that URL, so relative local assets resolve normally.
 */
export async function prime_local_file_origin(page, base_url, timeout_ms = 5000) {
  if (!base_url?.startsWith('file://')) return;

  // Only navigate when the directory genuinely exists — goto() on a missing
  // file:// path lands on an error page whose navigation can still be
  // settling when setContent() runs right after, destroying its execution
  // context ("Execution context was destroyed, most likely because of a
  // navigation"). A missing directory means no local assets could resolve
  // anyway, so skipping just falls back to the pre-fix (no local access) behavior.
  let local_path;

  try {
    local_path = fileURLToPath(base_url);
  } catch {
    return;
  }

  if (!existsSync(local_path)) return;

  try {
    await page.goto(base_url, { waitUntil: 'domcontentloaded', timeout: timeout_ms });
  } catch (error) {
    log({ level: 'warn', msg: `Could not prime local file origin for "${base_url}": ${error.message}` });
  }
}

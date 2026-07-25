import { existsSync } from 'fs';
import { CHROME_SANDBOX } from '../config/app_config.js';

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

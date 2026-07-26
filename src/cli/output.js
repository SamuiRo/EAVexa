import { print, banner as print_banner } from '../shared/utils.js';
import { log } from '../shared/logger.js';

// ─── stdout/stderr discipline ────────────────────────────────────────────────
// See docs/specification.md §11.3.
//
//   mode      | stdout                    | stderr
//   ----------|---------------------------|------------------------------
//   human     | pretty colored output     | —
//   --json    | exactly one JSON object   | banner, logs, progress
//   -o -      | raw output bytes          | banner, logs (banner suppressed)

/**
 * @param {{ json?: boolean, quiet?: boolean, verbose?: boolean, raw_stdout?: boolean }} [opts]
 */
export function create_output({ json = false, quiet = false, verbose = false, raw_stdout = false } = {}) {
  const human = !json && !raw_stdout;

  return {
    json,
    human,

    show_banner(text, subtitle) {
      if (human && !quiet) print_banner(text, subtitle);
    },

    info(text) {
      if (quiet) return;
      human ? print(text, 'info') : log({ level: 'info', msg: text });
    },

    success(text) {
      if (quiet) return;
      human ? print(text, 'success') : log({ level: 'info', msg: text });
    },

    warn(text) {
      human ? print(text, 'warning') : log({ level: 'warn', msg: text });
    },

    debug(text) {
      if (quiet || !verbose) return;
      human ? print(text, 'debug') : log({ level: 'debug', msg: text });
    },

    /**
     * Emit the command's structured result. Only writes to stdout in --json
     * mode — human mode result formatting is the caller's job (it knows the
     * friendliest way to phrase its own result).
     */
    result(value) {
      if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
    },

    error(error) {
      const payload = typeof error.toJSON === 'function'
        ? error.toJSON()
        : { code: 'INTERNAL', message: error.message };

      if (json || raw_stdout) {
        process.stderr.write(`${JSON.stringify({ ok: false, error: payload })}\n`);
      } else {
        print(error.message, 'error');
      }
    },
  };
}

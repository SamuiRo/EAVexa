import { parse_args } from '../args.js';
import { create_output } from '../output.js';
import { FORMATS } from '../../config/render_config.js';

const BOOLEANS = ['json', 'help'];
const ALIASES = { h: 'help' };

const HELP = `Usage: eavexa formats [options]

List the built-in output format presets.

Options:
      --json    Print machine-readable JSON instead of a human table`;

export default async function formats_command(argv) {
  const args = parse_args(argv, { aliases: ALIASES, booleans: BOOLEANS });

  if (args.help) {
    console.log(HELP);
    return;
  }

  const output = create_output({ json: !!args.json });
  const entries = Object.entries(FORMATS).map(([key, cfg]) => ({
    key, width: cfg.width, height: cfg.height, device_scale_factor: cfg.device_scale_factor, label: cfg.label,
  }));

  if (output.json) {
    output.result(entries);
    return;
  }

  for (const entry of entries) {
    output.success(`${entry.key.padEnd(16)} ${entry.label}`);
  }
}

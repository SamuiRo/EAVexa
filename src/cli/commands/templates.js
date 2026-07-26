import { parse_args } from '../args.js';
import { create_output } from '../output.js';
import TemplateRegistry from '../../core/template_registry.js';
import { RenderError } from '../../core/errors.js';
import { BUILTIN_TEMPLATES_DIR, TEMPLATES_DIR } from '../../config/app_config.js';

const BOOLEANS = ['json', 'help'];
const ALIASES = { h: 'help' };

const HELP = `Usage: eavexa templates <list|show> [name]

  list          List every template in the registry (user templates override builtin)
  show <name>   Print the full manifest for a template

Options:
      --json    Print machine-readable JSON instead of a human table`;

export default async function templates_command(argv) {
  const [subcommand, ...rest] = argv;
  const args = parse_args(rest, { aliases: ALIASES, booleans: BOOLEANS });

  if (args.help || !subcommand) {
    console.log(HELP);
    return;
  }

  const output = create_output({ json: !!args.json });
  const registry = new TemplateRegistry({ builtin_dir: BUILTIN_TEMPLATES_DIR, user_dir: TEMPLATES_DIR });

  try {
    if (subcommand === 'list') {
      await list_templates(registry, output);
      return;
    }

    if (subcommand === 'show') {
      await show_template(registry, args._[0], output);
      return;
    }

    throw new RenderError('INVALID_REQUEST', `Unknown "templates" subcommand "${subcommand}". Use "list" or "show <name>".`);
  } catch (error) {
    output.error(error);
    process.exitCode = error instanceof RenderError ? error.exit_code : 1;
  }
}

async function list_templates(registry, output) {
  const summaries = await registry.list();

  if (output.json) {
    output.result(summaries);
    return;
  }

  if (summaries.length === 0) {
    output.info('No templates found. Add one under templates/<name>/ or data/templates/<name>/.');
    return;
  }

  for (const tpl of summaries) {
    const flags = tpl.inferred ? '  (inferred)' : '';
    output.success(`${tpl.name}  [${tpl.source}]  ${tpl.kind}  ${tpl.vars_count} var(s)${flags}`);
  }
}

async function show_template(registry, name, output) {
  if (!name) {
    throw new RenderError('INVALID_REQUEST', 'Usage: eavexa templates show <name>');
  }

  const manifest = await registry.get(name);
  console.log(JSON.stringify(manifest, null, output.json ? 0 : 2));
}

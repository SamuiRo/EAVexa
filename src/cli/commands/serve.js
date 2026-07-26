import { parse_args } from '../args.js';
import { create_output } from '../output.js';
import { create_render_service } from '../../core/create_render_service.js';
import EAVexaServer from '../../server/server.js';
import { WELCOME_MESSAGE, SUB_TITLE } from '../../shared/messages.js';

const BOOLEANS = ['help'];
const ALIASES = { p: 'port', h: 'help' };

const HELP = `Usage: eavexa serve [options]

Start the HTTP API server — see docs/api.md for the full route reference.

Options:
  -p, --port <n>    Port to listen on (default: EAVEXA_PORT env, else 8080)
      --host <ip>   Host to bind (default: EAVEXA_HOST env, else 127.0.0.1)`;

export default async function serve_command(argv) {
  const args = parse_args(argv, { aliases: ALIASES, booleans: BOOLEANS });

  if (args.help) {
    console.log(HELP);
    return;
  }

  const output = create_output({});
  const service = create_render_service();
  const server = new EAVexaServer({
    service,
    ...(args.port !== undefined ? { port: Number(args.port) } : {}),
    ...(args.host !== undefined ? { host: args.host } : {}),
  });

  await server.listen();

  output.show_banner(WELCOME_MESSAGE, SUB_TITLE);
  output.success(`Listening on http://${server.address.address}:${server.address.port}`);
  output.info('Press Ctrl+C to stop.');

  let shutting_down = false;

  const shutdown = async signal => {
    if (shutting_down) return;
    shutting_down = true;

    output.info(`Received ${signal} — waiting for active renders to finish...`);
    await server.close();
    output.success('Shut down cleanly.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

import batch_command from './cli/commands/batch.js';

// `npm start` is a thin alias for `eavexa batch` — the legacy jobs.json
// workflow, now implemented once under src/cli/commands/batch.js.
await batch_command(process.argv.slice(2));

#!/usr/bin/env node
import render_command from './commands/render.js';
import batch_command from './commands/batch.js';
import templates_command from './commands/templates.js';
import formats_command from './commands/formats.js';
import doctor_command from './commands/doctor.js';
import jobs_command from './commands/jobs.js';
import { RenderError } from '../core/errors.js';

const COMMANDS = {
  render: render_command,
  batch: batch_command,
  templates: templates_command,
  formats: formats_command,
  doctor: doctor_command,
  jobs: jobs_command,
};

const HELP = `EAVexa — render HTML templates to PNG images and MP4/WebM/MOV/MKV videos.

Usage: eavexa <command> [options]

Commands:
  render      Render a single template to an image or video
  batch       Render every enabled job in data/jobs.json
  templates   list | show <name>
  formats     List available output format presets
  doctor      Check the local environment (Chromium, FFmpeg, paths)
  jobs        list | show | cancel | prune | stats — async job records

Run "eavexa <command> --help" for command-specific options.`;

async function main() {
  const [command_name, ...rest] = process.argv.slice(2);

  if (!command_name || command_name === '--help' || command_name === '-h') {
    console.log(HELP);
    return;
  }

  const command = COMMANDS[command_name];

  if (!command) {
    process.stderr.write(`Unknown command "${command_name}". Run "eavexa --help" for usage.\n`);
    process.exitCode = 2;
    return;
  }

  try {
    await command(rest);
  } catch (error) {
    const payload = typeof error.toJSON === 'function' ? error.toJSON() : { code: 'INTERNAL', message: error.message };
    process.stderr.write(`${JSON.stringify({ ok: false, error: payload })}\n`);
    process.exitCode = error instanceof RenderError ? error.exit_code : 1;
  }
}

await main();

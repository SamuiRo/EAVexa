import TemplateRegistry from './template_registry.js';
import BrowserPool from './browser_pool.js';
import RenderQueue from './render_queue.js';
import StorageAdapter from './storage_adapter.js';
import RenderService from './render_service.js';
import { BUILTIN_TEMPLATES_DIR, TEMPLATES_DIR } from '../config/app_config.js';

/**
 * Wires the default core stack (registry, pool, queue, storage) into a
 * RenderService. The one place that constructs these dependencies, shared by
 * the CLI commands and the legacy jobs.json entry point.
 *
 * @param {{ registry?, pool?, queue?, storage?, queue_options? }} [overrides]
 */
export function create_render_service(overrides = {}) {
  const registry = overrides.registry ?? new TemplateRegistry({
    builtin_dir: BUILTIN_TEMPLATES_DIR,
    user_dir:    TEMPLATES_DIR,
  });
  const pool    = overrides.pool ?? new BrowserPool();
  const queue   = overrides.queue ?? new RenderQueue(overrides.queue_options);
  const storage = overrides.storage ?? new StorageAdapter();

  return new RenderService({ registry, pool, queue, storage });
}

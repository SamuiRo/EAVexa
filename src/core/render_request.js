import path from 'path';
import { RenderError } from './errors.js';
import { new_render_id } from './ids.js';
import { build_render_options } from '../config/render_config.js';
import { validate_vars } from './template_manifest.js';
import {
  MAX_WIDTH, MAX_HEIGHT, MAX_VIDEO_DURATION, MAX_FPS, MAX_FRAMES,
  SYNC_MAX_COST, RENDER_TIMEOUT_MS, NETWORK_TIMEOUT_MS, FONT_TIMEOUT_MS,
  TEMPLATE_ALLOWED_HOSTS,
} from '../config/app_config.js';

const DEFAULT_VIDEO = { fps: 30, crf: 18, preset: 'medium', webm_crf: 32, keep_frames: false };

/**
 * Normalize a raw request (CLI flags, HTTP body, or a jobs.json entry) into
 * the one shape every front-end and RenderService agree on.
 * See docs/specification.md §5.5.
 *
 * @param {Object} raw
 * @param {Object} ctx  { registry: TemplateRegistry }
 */
export async function normalize_request(raw, ctx = {}) {
  const render_id = raw.render_id ?? new_render_id();
  const source     = await resolve_source(raw.source ?? {}, ctx);

  const format = normalize_format(raw.format ?? source.template?.manifest?.default_format);
  const vars   = normalize_vars(raw.vars, source.template?.manifest);

  const raw_video = raw.video !== undefined ? raw.video : source.template?.manifest?.video ?? null;
  const video      = raw_video ? normalize_video(raw_video) : null;

  const cost = { frames: video ? Math.round(video.duration * video.fps) : 1, estimate_ms: null };

  if (cost.frames > MAX_FRAMES) {
    throw new RenderError('LIMIT_EXCEEDED', `Frame count ${cost.frames} exceeds MAX_FRAMES (${MAX_FRAMES})`, {
      frames: cost.frames, max_frames: MAX_FRAMES,
    });
  }

  const mode = decide_mode(raw, cost);

  return {
    render_id,
    source: {
      kind: source.kind, name: source.name ?? null, html: source.html ?? null,
      path: source.path ?? null, url: source.url ?? null, base_dir: source.base_dir,
    },
    template: source.template ?? null,
    format,
    vars,
    video,
    output:  normalize_output(raw.output, render_id, video),
    options: normalize_options(raw.options),
    callback: raw.callback_url ? { url: raw.callback_url, headers: raw.callback_headers ?? {} } : null,
    metadata: raw.metadata ?? {},
    mode,
    cost,
    origin: raw.origin ?? { via: 'internal', public_base_url: null },
  };
}

// ─── Source resolution ────────────────────────────────────────────────────

async function resolve_source(raw_source, ctx) {
  const present = ['name', 'html', 'path', 'url'].filter(key => raw_source[key] != null);

  if (present.length !== 1) {
    throw new RenderError('INVALID_REQUEST', 'Exactly one of source.name / source.html / source.path / source.url is required', {
      given: present,
    });
  }

  if (raw_source.name) {
    if (!ctx.registry) {
      throw new RenderError('TEMPLATE_NOT_FOUND', `No template registry configured to resolve "${raw_source.name}"`, {
        template: raw_source.name,
      });
    }

    const resolved = await ctx.registry.resolve(raw_source.name);

    return {
      kind: 'registry',
      name: raw_source.name,
      base_dir: resolved.base_dir,
      template: { name: raw_source.name, manifest: resolved.manifest },
    };
  }

  if (raw_source.html) {
    return {
      kind: 'inline',
      html: raw_source.html,
      base_dir: raw_source.base_dir ?? null,
      template: null,
    };
  }

  if (raw_source.path) {
    return {
      kind: 'file',
      path: raw_source.path,
      base_dir: path.dirname(raw_source.path),
      template: null,
    };
  }

  const url = new URL(raw_source.url);

  if (TEMPLATE_ALLOWED_HOSTS && !TEMPLATE_ALLOWED_HOSTS.includes(url.hostname)) {
    throw new RenderError('TEMPLATE_FETCH_FAILED', `Host "${url.hostname}" is not in TEMPLATE_ALLOWED_HOSTS`, {
      host: url.hostname,
    });
  }

  return { kind: 'url', url: raw_source.url, base_dir: raw_source.url, template: null };
}

// ─── Format ────────────────────────────────────────────────────────────────

function normalize_format(format) {
  if (!format) {
    throw new RenderError('INVALID_REQUEST', 'format is required');
  }

  let render_opts;

  try {
    render_opts = build_render_options(format);
  } catch (error) {
    throw new RenderError('UNKNOWN_FORMAT', error.message, { format });
  }

  const { viewport, device_scale_factor } = render_opts;

  if (viewport.width > MAX_WIDTH || viewport.height > MAX_HEIGHT) {
    throw new RenderError('LIMIT_EXCEEDED', `Requested size ${viewport.width}x${viewport.height} exceeds MAX_WIDTH/MAX_HEIGHT (${MAX_WIDTH}x${MAX_HEIGHT})`, {
      width: viewport.width, height: viewport.height, max_width: MAX_WIDTH, max_height: MAX_HEIGHT,
    });
  }

  return {
    key: typeof format === 'string' ? format : null,
    width: viewport.width,
    height: viewport.height,
    device_scale_factor,
  };
}

// ─── Vars ──────────────────────────────────────────────────────────────────

function normalize_vars(raw_vars = {}, manifest) {
  if (!manifest) return { ...raw_vars };

  const { values } = validate_vars(manifest, raw_vars);
  return values;
}

// ─── Video ─────────────────────────────────────────────────────────────────

function normalize_video(raw_video) {
  if (raw_video.duration === undefined) {
    throw new RenderError('INVALID_REQUEST', 'video.duration is required');
  }

  const duration = Number(raw_video.duration);
  const fps      = Number(raw_video.fps ?? DEFAULT_VIDEO.fps);
  const crf      = Number(raw_video.crf ?? DEFAULT_VIDEO.crf);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RenderError('INVALID_REQUEST', '"video.duration" must be a positive number of seconds');
  }

  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RenderError('INVALID_REQUEST', '"video.fps" must be a positive number');
  }

  if (!Number.isFinite(crf) || crf < 0 || crf > 63) {
    throw new RenderError('INVALID_REQUEST', '"video.crf" must be a number from 0 to 63');
  }

  if (duration > MAX_VIDEO_DURATION) {
    throw new RenderError('LIMIT_EXCEEDED', `video.duration ${duration}s exceeds MAX_VIDEO_DURATION (${MAX_VIDEO_DURATION}s)`, {
      duration, max_duration: MAX_VIDEO_DURATION,
    });
  }

  if (fps > MAX_FPS) {
    throw new RenderError('LIMIT_EXCEEDED', `video.fps ${fps} exceeds MAX_FPS (${MAX_FPS})`, { fps, max_fps: MAX_FPS });
  }

  return {
    ...DEFAULT_VIDEO,
    ...raw_video,
    duration,
    fps,
    crf,
    keep_frames: raw_video.keep_frames === true,
  };
}

// ─── Mode ──────────────────────────────────────────────────────────────────

function decide_mode(raw, cost) {
  if (raw.callback_url || raw.mode === 'async') return 'async';
  if (raw.mode === 'sync') return 'sync';
  if (cost.frames > SYNC_MAX_COST) return 'async';

  return 'sync';
}

// ─── Output / options ──────────────────────────────────────────────────────

function normalize_output(raw_output = {}, render_id, video) {
  return {
    type:     raw_output.type ?? 'binary',
    filename: raw_output.filename ?? `${render_id}.${video ? 'mp4' : 'png'}`,
    dir:      raw_output.dir ?? null,
    s3:       raw_output.s3 ?? null,
    push:     raw_output.push ?? null,
  };
}

function normalize_options(raw_options = {}) {
  return {
    timeout_ms:         raw_options.timeout_ms ?? RENDER_TIMEOUT_MS,
    settle_ms:          raw_options.settle_ms,
    network_timeout_ms: raw_options.network_timeout_ms ?? NETWORK_TIMEOUT_MS,
    font_timeout_ms:    raw_options.font_timeout_ms ?? FONT_TIMEOUT_MS,
    // offline / strict_assets are accepted for forward compatibility but not
    // yet enforced by the renderers — see docs/decisions.md Р1.
    offline:       raw_options.offline === true,
    strict_assets: raw_options.strict_assets === true,
  };
}

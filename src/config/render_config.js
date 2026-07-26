// ─── Render formats config ────────────────────────────────────────────────────

/**
 * Output extensions the image renderer can actually produce.
 */
export const IMAGE_OUTPUT_EXTENSIONS = ['.png'];

/**
 * Predefined output formats for social media posts and stories.
 * All dimensions are in logical CSS pixels; device_scale_factor controls DPI.
 */
export const FORMATS = {
    // Instagram / Facebook square post
    post_square: {
      width:             1080,
      height:            1080,
      device_scale_factor: 2,
      label:             'Post Square (1080×1080)',
    },
  
    // Instagram landscape post
    post_landscape: {
      width:             1080,
      height:            566,
      device_scale_factor: 2,
      label:             'Post Landscape (1080×566)',
    },
  
    // Instagram portrait post (4:5)
    post_portrait: {
      width:             1080,
      height:            1350,
      device_scale_factor: 2,
      label:             'Post Portrait (1080×1350)',
    },
  
    // Instagram / TikTok story (9:16)
    story: {
      width:             1080,
      height:            1920,
      device_scale_factor: 2,
      label:             'Story (1080×1920)',
    },
  
    // Twitter / X card
    twitter_card: {
      width:             1200,
      height:            628,
      device_scale_factor: 2,
      label:             'Twitter Card (1200×628)',
    },
  
    // LinkedIn post
    linkedin: {
      width:             1200,
      height:            627,
      device_scale_factor: 2,
      label:             'LinkedIn (1200×627)',
    },
  
    // Custom — pass { width, height, device_scale_factor } directly
  };
  
  // Matches "1080x1920" or "1080x1920@2" (dpr defaults to 2 when omitted).
  const DIMENSION_PATTERN = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/i;

  function resolve_format_config(format) {
    if (format && typeof format === 'object') return format;
    if (typeof format !== 'string') return null;

    if (FORMATS[format]) return FORMATS[format];

    const match = DIMENSION_PATTERN.exec(format.trim());
    if (!match) return null;

    const [, width, height, dpr] = match;
    return {
      width:  Number(width),
      height: Number(height),
      device_scale_factor: dpr ? Number(dpr) : 2,
    };
  }

  /**
   * Build a viewport + screenshot config from a format key, a "WxH@dpr"
   * string (e.g. "1080x1920@2"), or raw dimensions.
   *
   * @param {string|Object} format  FORMATS key, "WxH@dpr" string, or { width, height, device_scale_factor }
   * @returns {{ viewport: Object, device_scale_factor: number, clip: Object }}
   */
  export function build_render_options(format) {
    const cfg = resolve_format_config(format);

    if (!cfg) {
      throw new Error(`Unknown format: "${format}". Available: ${Object.keys(FORMATS).join(', ')}`);
    }

    const { width, height, device_scale_factor = 2 } = cfg;

    return {
      viewport:            { width, height },
      device_scale_factor,
      clip:                { x: 0, y: 0, width, height },
    };
  }
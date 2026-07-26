// ─── Error codes ──────────────────────────────────────────────────────────────
// See docs/specification.md §5.1 for the full contract this table implements.

const ERROR_TABLE = {
  INVALID_REQUEST:       { http_status: 400, exit_code: 2 },
  MISSING_REQUIRED_VAR:  { http_status: 400, exit_code: 2 },
  UNKNOWN_FORMAT:        { http_status: 400, exit_code: 2 },
  LIMIT_EXCEEDED:        { http_status: 400, exit_code: 2 },
  TEMPLATE_NOT_FOUND:    { http_status: 404, exit_code: 2 },
  TEMPLATE_INVALID:      { http_status: 400, exit_code: 2 },
  TEMPLATE_FETCH_FAILED: { http_status: 502, exit_code: 1 },
  ASSET_LOAD_FAILED:     { http_status: 502, exit_code: 1 },
  PAGE_ERROR:            { http_status: 500, exit_code: 1 },
  RENDER_TIMEOUT:        { http_status: 408, exit_code: 3 },
  ENCODE_FAILED:         { http_status: 500, exit_code: 1 },
  STORAGE_FAILED:        { http_status: 500, exit_code: 1 },
  DELIVERY_FAILED:       { http_status: 502, exit_code: 5 },
  CALLBACK_FAILED:       { http_status: null, exit_code: 5 },
  RESULT_GONE:           { http_status: 410, exit_code: 1 },
  JOB_NOT_FOUND:         { http_status: 404, exit_code: 2 },
  QUEUE_FULL:            { http_status: 503, exit_code: 1 },
  UNAUTHORIZED:          { http_status: 401, exit_code: 2 },
  PAYLOAD_TOO_LARGE:     { http_status: 413, exit_code: 2 },
  DEPENDENCY_MISSING:    { http_status: 503, exit_code: 4 },
  INTERRUPTED:           { http_status: 500, exit_code: 1 },
  CANCELLED:             { http_status: 499, exit_code: 1 },
  INTERNAL:              { http_status: 500, exit_code: 1 },
};

/**
 * The one error type the render core throws. Carries enough shape for every
 * front-end (HTTP status, CLI exit code) even though only some fronts exist yet.
 */
export class RenderError extends Error {
  constructor(code, message, details = {}) {
    super(message);

    const meta = ERROR_TABLE[code] ?? ERROR_TABLE.INTERNAL;

    this.name        = 'RenderError';
    this.code        = ERROR_TABLE[code] ? code : 'INTERNAL';
    this.details      = details;
    this.http_status  = meta.http_status;
    this.exit_code    = meta.exit_code;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function is_known_error_code(code) {
  return code in ERROR_TABLE;
}

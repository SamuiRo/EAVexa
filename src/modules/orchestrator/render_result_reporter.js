import path from 'path';
import { OUTPUT_DIR } from '../../config/app_config.js';
import { print, format_bytes } from '../../shared/utils.js';

/**
 * Prints RenderResult objects (see docs/specification.md §6.5) in a
 * consistent CLI format.
 */
export default class RenderResultReporter {
  constructor(options = {}) {
    this.output_dir = options.output_dir ?? OUTPUT_DIR;
  }

  /**
   * @param {Array<Object>} results
   */
  print_results(results) {
    for (const result of results) {
      this.print_result(result);
    }
  }

  print_result(result) {
    const rel_path = path.relative(this.output_dir, result.local_path ?? result.path);
    const size     = format_bytes(result.bytes);

    if (result.type === 'video') {
      print(
        `${rel_path}  ->  ${result.width}x${result.height}px  @${result.dpr}x  ${result.frames} frames  ${result.fps}fps  (${size})`,
        'success',
      );
      return;
    }

    print(
      `${rel_path}  ->  ${result.width}x${result.height}px  @${result.dpr}x  (${size})`,
      'success',
    );
  }
}

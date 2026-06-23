import path           from 'path';
import { OUTPUT_DIR } from '../../config/app_config.js';
import { print }      from '../../shared/utils.js';

/**
 * Prints render results in a consistent CLI format.
 */
export default class RenderResultReporter {
  constructor(options = {}) {
    this.output_dir = options.output_dir ?? OUTPUT_DIR;
  }

  /**
   * Print all render results.
   *
   * @param {Array<Object>} results
   */
  print_results(results) {
    for (const result of results) {
      this.print_result(result);
    }
  }

  print_result(result) {
    const rel_output = path.relative(this.output_dir, result.output_path);

    if (result.type === 'video') {
      print(
        `${rel_output}  ->  ${result.width}x${result.height}px  @${result.dpr}x  ${result.frames} frames  ${result.fps}fps`,
        'success',
      );
      return;
    }

    print(
      `${rel_output}  ->  ${result.width}x${result.height}px  @${result.dpr}x`,
      'success',
    );
  }
}

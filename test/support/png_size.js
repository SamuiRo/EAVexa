const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Read the actual pixel width/height from a PNG buffer's IHDR chunk.
 * Used to verify real rendered output, not just the numbers we asked for.
 */
export function read_png_size(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG buffer (bad signature)');
  }

  return {
    width:  buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

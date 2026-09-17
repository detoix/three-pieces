const UINT32_BYTES = Uint32Array.BYTES_PER_ELEMENT;

/**
 * Seven 32-bit words: exact world X/Z bits plus five packed attribute words.
 *
 * The seventh word is the crown's clump. It is stored rather than re-derived
 * because the alternative is a nine-cell Voronoi search per *vertex* -- 405
 * neighbour hashes for a near crown's 45 vertices, for a value that is the
 * same at every one of them. Four bytes a candidate buys that back: 4.18 MiB
 * over the three rings, against the 25.1 MiB packing already saved.
 */
export const GRASS_RECORD_WORDS = 7;
export const GRASS_RECORD_BYTES = GRASS_RECORD_WORDS * UINT32_BYTES;
export const GRASS_VISIBLE_ID_BYTES = UINT32_BYTES;

export function grassStorageFootprint(candidateCount) {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
    throw new RangeError(
      'Grass candidate count must be a non-negative integer.',
    );
  }

  const recordBytes = candidateCount * GRASS_RECORD_BYTES;
  const visibleIdBytes = candidateCount * GRASS_VISIBLE_ID_BYTES;
  return Object.freeze({
    recordBytes,
    visibleIdBytes,
    totalBytes: recordBytes + visibleIdBytes,
  });
}

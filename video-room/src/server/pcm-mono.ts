/** Average interleaved stereo Int16 PCM into mono Int16. */
export function stereoInt16ToMono(stereo: Int16Array): Int16Array {
  if (stereo.length === 0) return stereo;
  const monoLength = Math.floor(stereo.length / 2);
  const mono = new Int16Array(monoLength);
  for (let i = 0; i < monoLength; i += 1) {
    const left = stereo[i * 2]!;
    const right = stereo[i * 2 + 1]!;
    mono[i] = Math.round((left + right) / 2);
  }
  return mono;
}

/** Convert mono Int16 samples to planar float in [-1, 1] for Opus. */
export function monoInt16ToFloat32(mono: Int16Array): Float32Array {
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    out[i] = mono[i]! / 32768;
  }
  return out;
}

/** Stereo Int16 → mono float for Opus encode. */
export function stereoInt16ToMonoFloat32(stereo: Int16Array): Float32Array {
  return monoInt16ToFloat32(stereoInt16ToMono(stereo));
}

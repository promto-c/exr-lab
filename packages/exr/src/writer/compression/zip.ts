import { zlibSync } from 'fflate';
import { applyPredictor, interleave } from './zipPredictor';

export function encodeZipChunk(raw: Uint8Array): Uint8Array {
  const encoded = zlibSync(applyPredictor(interleave(raw)));
  return encoded.byteLength >= raw.byteLength ? raw : encoded;
}

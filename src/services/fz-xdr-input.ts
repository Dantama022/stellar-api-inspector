import fs from 'fs';

/** Reads an XDR artifact from a file path or stdin ('-') and returns raw bytes. Accepts base64, hex, or binary. */
export function fzReadXdrInput(source: string): Buffer {
  let raw: Buffer;
  try {
    raw = source === '-' ? fs.readFileSync(0) : fs.readFileSync(source);
  } catch (e) {
    throw new Error(`Cannot read XDR input: ${(e as Error).message}`);
  }
  return fzDecodeXdrText(raw);
}

export function fzDecodeXdrText(raw: Buffer): Buffer {
  const text = raw.toString('utf8').trim();
  if (text.length === 0) throw new Error('XDR input is empty');
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return raw;
}

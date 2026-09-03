import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secretBase32: string): Buffer {
  const normalized = secretBase32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!normalized) {
    throw new Error('TOTP secret khong hop le.');
  }

  let bits = '';
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error(`Ky tu base32 khong hop le: ${char}`);
    }

    bits += index.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    (((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)) %
    10 ** digits;

  return code.toString().padStart(digits, '0');
}

export function generateTOTP(
  secretBase32: string,
  nowMs = Date.now(),
  stepSeconds = 30,
  digits = 6
): string {
  const secret = decodeBase32(secretBase32);
  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  return hotp(secret, counter, digits);
}

export function verifyTOTP(
  secretBase32: string,
  token: string,
  window = 1,
  nowMs = Date.now(),
  stepSeconds = 30,
  digits = 6
): boolean {
  const secret = decodeBase32(secretBase32);
  const counter = Math.floor(nowMs / 1000 / stepSeconds);

  for (let delta = -window; delta <= window; delta += 1) {
    if (hotp(secret, counter + delta, digits) === token) {
      return true;
    }
  }

  return false;
}

export async function waitForFreshTOTP(
  secretBase32: string,
  minimumFreshSeconds = 5
): Promise<string> {
  const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);

  if (secondsRemaining < minimumFreshSeconds) {
    const waitMs = secondsRemaining * 1000 + 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  return generateTOTP(secretBase32);
}

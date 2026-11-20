// TON address normalisation. One wallet can appear as EQ… (bounceable),
// UQ… (non-bounceable) or raw "0:hex"; uniqueness checks (one wallet per
// account) must always compare the raw form.

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const RAW = /^(-1|0):([0-9a-fA-F]{64})$/;

/** Returns "workchain:hex64" (lowercase) or null when the address is invalid. */
export function toRawAddress(input: string): string | null {
  const value = input.trim();
  const raw = RAW.exec(value);
  if (raw) return `${raw[1]}:${raw[2].toLowerCase()}`;
  if (!/^[A-Za-z0-9_-]{48}$|^[A-Za-z0-9+/]{48}$/.test(value)) return null;
  const bytes = Uint8Array.from(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  if (bytes.length !== 36) return null;
  const expected = (bytes[34] << 8) | bytes[35];
  if (crc16(bytes.subarray(0, 34)) !== expected) return null;
  const tag = bytes[0] & ~0x80 & ~0x40; // strip testnet-only (0x80) flag
  if (tag !== 0x11 && tag !== 0x51) return null;
  const wc = bytes[1] === 0xff ? -1 : bytes[1];
  if (wc !== 0 && wc !== -1) return null;
  return `${wc}:${Buffer.from(bytes.subarray(2, 34)).toString("hex")}`;
}

export function sameAddress(a: string, b: string): boolean {
  const x = toRawAddress(a);
  const y = toRawAddress(b);
  return x !== null && x === y;
}

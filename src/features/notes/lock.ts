/** Password-locked notes: the content is encrypted here, in the window, with a key made from the
 *  password (PBKDF2-SHA-256, 310 000 rounds, AES-256-GCM). Only the encrypted text is saved and
 *  synced; the password is never stored, so a forgotten one can't be recovered. The title stays
 *  readable, so the note can be found. */

const VERSION = 'v1'
const ROUNDS = 310_000

const toBase64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), c => c.charCodeAt(0))

async function keyFrom(password: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ROUNDS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** "v1.<salt>.<iv>.<ciphertext>", each base64. */
export async function lockText(text: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(password, salt), new TextEncoder().encode(text)))
  return [VERSION, toBase64(salt), toBase64(iv), toBase64(sealed)].join('.')
}

export async function unlockText(payload: string, password: string): Promise<string> {
  const [version, salt, iv, sealed] = payload.trim().split('.')
  if (version !== VERSION || !salt || !iv || !sealed) throw new Error('This locked note can’t be read by this version of BridgeDeck')
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await keyFrom(password, fromBase64(salt)), fromBase64(sealed))
    return new TextDecoder().decode(plain)
  } catch {
    throw new Error('Wrong password')
  }
}

export const isLockPayload = (text: string) => /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(text.trim())

/** One-time codes in incoming texts ("Your verification code is 482913", "G-123456 is your Google
 *  verification code"), so they can be copied and filled in without retyping. */

const KEYWORD = /\b(code|codes|verification|verify|otp|passcode|pass code|password|pin|one[- ]?time|2fa|two[- ]factor|log ?in|sign[- ]?in|security|confirm|authenticat\w*|token)\b|验证码|código|code de|Code:/i
/** A code right after words that introduce it: digits, or letters and digits mixed. */
const INTRODUCED = /\b(?:code|passcode|pin|otp|password)(?:\s+is|:|\s*-)?\s*:?\s*([A-Z0-9]{4,8}|\d{3}[- ]\d{3})\b/i
/** Digit runs that could be a code: 4–8 digits, or 3+3 split by a space or dash, maybe after "G-". */
const DIGITS = /(?<![\w$€£.,/:-])(?:[A-Z]{1,2}-)?(\d{3}[- ]\d{3}|\d{4,8})(?![\w%/:]|[.,]\d)/g

const clean = (code: string) => code.replace(/[- ]/g, '')
const plausible = (code: string) => /\d/.test(code) && !/^(19|20)\d\d$/.test(code)

/** The code in a text, or null when it doesn't look like a code message. */
export function findCode(text: string | null | undefined): string | null {
  if (!text || text.length > 600 || !KEYWORD.test(text)) return null
  const introduced = text.match(INTRODUCED)?.[1]
  if (introduced && plausible(clean(introduced)) && !/^[a-z]+$/i.test(introduced)) return clean(introduced).toUpperCase()
  const found = [...text.matchAll(DIGITS)].map(m => clean(m[1])).filter(plausible)
  if (!found.length) return null
  // Several numbers (a code and an amount, a phone number…): the one nearest the word "code".
  if (found.length === 1) return found[0]
  const at = text.search(/code|otp|pin|passcode/i)
  if (at < 0) return found[0]
  const where = (code: string) => Math.abs(text.replace(/(\d)[- ](\d)/g, '$1$2').indexOf(code) - at)
  return found.slice().sort((a, b) => where(a) - where(b))[0]
}

/** "482913" → "482 913", easier to read off. */
export function spacedCode(code: string) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

/** True if the string contains ASCII control characters (incl. CR/LF/NUL/DEL). */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

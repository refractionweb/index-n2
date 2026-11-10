// ft populates `language` with a mix of real ISO 639-1 codes and sentinel
// values for non-text content (`zxx` no linguistic content, `qme` private
// use, `und` undefined). Real ISO 639-1 is always two lowercase letters;
// the regex passes only those, so 3-letter sentinels and any future Twitter
// `qXX` triple are filtered as a side effect rather than via a hardcoded
// blacklist. We do NOT exclude `en` — assuming English-as-default is
// US-centric; a Japanese user has `ja` as their default and `en` is the
// outlier.
export function isDisplayableLanguage(
  lang: string | null | undefined,
): boolean {
  if (!lang) return false;
  return /^[a-z]{2}$/.test(lang);
}

// Intl.DisplayNames is built into modern browsers and Node 18+; the try/
// catch is a defensive fallback in case the runtime ever lacks it. We
// always render in English ("Japanese", not "日本語") because the audience
// is mixed-locale and surfacing localized names per user's OS would diverge
// the UI between machines without a clear win — the codes themselves are
// universal but unreadable, names in English are universal AND readable.
const _languageDisplay = (() => {
  try {
    return new Intl.DisplayNames(["en"], {
      type: "language",
      fallback: "code",
    });
  } catch {
    return null;
  }
})();

// "ja" → "Japanese", "cs" → "Czech", "ro" → "Romanian". For codes the
// runtime doesn't recognize, returns the uppercased code as a graceful
// fallback (Intl.DisplayNames echoes the input back with `fallback: "code"`,
// so we detect that case to avoid rendering raw lowercase letters).
export function formatLanguageName(code: string | null | undefined): string {
  if (!code) return "";
  const name = _languageDisplay?.of(code);
  if (name && name.toLowerCase() !== code.toLowerCase()) return name;
  return code.toUpperCase();
}

"use client";

import * as React from "react";
import { dictionaries, type Locale, type Dictionary } from "./dictionaries";

type I18nContextValue = {
  locale: Locale;
  /**
   * Kept on the context for compatibility with components that already accept
   * a setter (e.g. the previous Settings → Language picker). The platform is
   * English-only now so this is a no-op — calls are silently ignored.
   */
  setLocale: (l: Locale) => void;
  t: Dictionary;
};

const I18nContext = React.createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Locale is hard-coded to "en". Multi-locale support was removed when the
  // product went English-only — the dictionaries file still ships only the
  // `en` variant. If we ever bring back UK (or add another language), this
  // is the place that switches back to a stateful locale.
  const value = React.useMemo<I18nContextValue>(
    () => ({
      locale: "en",
      setLocale: () => {},
      t: dictionaries.en,
    }),
    []
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

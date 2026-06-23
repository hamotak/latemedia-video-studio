import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/provider";
import { ThemeProvider } from "@/lib/theme-provider";
import { ShellWrapper } from "@/components/shell-wrapper";

export const metadata: Metadata = {
  title: "Late Media App",
  description: "Ideation, competitor research, channel context, and thumbnail generation for Late Media.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <I18nProvider>
            <ShellWrapper>{children}</ShellWrapper>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Standalone build: single built-in admin, no auth gate.
  return <>{children}</>;
}

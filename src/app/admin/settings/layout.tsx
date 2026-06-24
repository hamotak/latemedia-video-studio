import { PageContainer } from "@/components/ui/page-container";

export default function AdminSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageContainer className="max-w-3xl space-y-5">
      <h1 className="text-[19px] font-semibold leading-tight tracking-normal text-foreground">
        Settings
      </h1>
      {children}
    </PageContainer>
  );
}

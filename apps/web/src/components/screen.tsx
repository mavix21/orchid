// Mobile-first screen column. The Figma status bar (9:41) is device chrome and is not rendered.
export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background text-foreground">
      {children}
    </div>
  );
}

// Bottom action area; pb-8.5 matches the 34px home-indicator inset in Figma.
export function ScreenActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 pt-4 pb-8.5">
      {children}
    </div>
  );
}

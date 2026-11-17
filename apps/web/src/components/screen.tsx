export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full pt-safe max-w-md flex-col bg-background text-foreground">
      {children}
    </div>
  );
}

export function ScreenActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 pt-4 pb-safe">
      {children}
    </div>
  );
}

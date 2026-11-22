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

export function ScreenStatus({
  title,
  media,
  children,
  ...props
}: {
  title: React.ReactNode;
  media?: React.ReactNode;
  children?: React.ReactNode;
} & Omit<React.ComponentProps<"main">, "className" | "role" | "title">) {
  return (
    <main
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-4 px-5 py-8 text-center"
      {...props}
    >
      {media}
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-display text-h1 text-balance">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function ScreenNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-body text-pretty text-muted-foreground">{children}</p>
  );
}

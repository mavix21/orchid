import { Button } from "@workspace/ui/components/button";

export function TopNav({
  title,
  label,
  icon,
  link,
  disabled = false,
}: {
  title: string;
  label: string;
  icon: React.ReactNode;
  link: React.ReactElement;
  disabled?: boolean;
}) {
  return (
    <header className="flex h-14 items-center gap-2 px-5">
      <Button
        variant="secondary"
        size="icon"
        data-testid="top-nav-action"
        aria-label={label}
        nativeButton={false}
        disabled={disabled}
        render={link}
      >
        {icon}
      </Button>
      <p className="flex-1 text-center text-label-lg">{title}</p>
      <div className="size-10" />
    </header>
  );
}

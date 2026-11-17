import { Button } from "@workspace/ui/components/button";

// Figma Nav/Top: round leading action, centered title, empty trailing slot.
export function TopNav({
  title,
  label,
  icon,
  link,
}: {
  title: string;
  label: string;
  icon: React.ReactNode;
  link: React.ReactElement;
}) {
  return (
    <header className="flex h-14 items-center gap-2 px-4">
      <Button
        variant="secondary"
        size="icon"
        aria-label={label}
        nativeButton={false}
        render={link}
      >
        {icon}
      </Button>
      <p className="flex-1 text-center text-label-lg">{title}</p>
      <div className="size-10" />
    </header>
  );
}

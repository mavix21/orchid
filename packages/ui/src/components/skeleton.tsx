import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@workspace/ui/lib/utils";

const skeletonVariants = cva("animate-pulse bg-muted", {
  variants: {
    variant: {
      text: "rounded-md",
      avatar: "rounded-full",
      tile: "rounded-lg",
    },
  },
  defaultVariants: {
    variant: "text",
  },
});

function Skeleton({
  className,
  variant = "text",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      data-slot="skeleton"
      data-variant={variant}
      className={cn(skeletonVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Skeleton };

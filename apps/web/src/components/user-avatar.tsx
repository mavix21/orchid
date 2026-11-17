import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar";

import type { Profile } from "@/fixtures/types";

// Figma Avatar: the flower takes the dark ink of its pastel tone via currentColor.
export function UserAvatar({
  profile,
  size,
}: {
  profile: Profile;
  size?: "default" | "xl";
}) {
  return (
    <Avatar tone={profile.tone} size={size}>
      <AvatarFallback>
        <svg
          viewBox="0 0 40 40"
          fill="none"
          aria-hidden="true"
          className="size-full"
        >
          {profile.petals.map((d) => (
            <path
              key={d}
              d={d}
              fillRule="evenodd"
              clipRule="evenodd"
              fill="currentColor"
            />
          ))}
        </svg>
      </AvatarFallback>
    </Avatar>
  );
}

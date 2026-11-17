import { LinkIcon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@workspace/ui/components/item";
import { cn } from "@workspace/ui/lib/utils";

import { UserAvatar } from "@/components/user-avatar";
import type { Activity } from "@/fixtures/activity";

export function ActivityRow({ activity }: { activity: Activity }) {
  return (
    <Item size="sm" role="listitem">
      <ItemMedia variant={activity.profile ? "default" : "icon"}>
        {activity.profile ? (
          <UserAvatar profile={activity.profile} />
        ) : (
          <LinkIcon absoluteStrokeWidth />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{activity.title}</ItemTitle>
        <ItemDescription>{activity.note}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <div className="flex flex-col items-end gap-1">
          <span
            className={cn(
              "text-numeric-lg tabular-nums",
              activity.received ? "text-positive" : "text-foreground",
            )}
          >
            {activity.amount}
          </span>
          {activity.pending ? (
            <Badge variant="warning">
              <span className="size-1.5 rounded-full bg-current" />
              Pendiente
            </Badge>
          ) : (
            <span className="text-caption text-muted-foreground">
              {activity.time}
            </span>
          )}
        </div>
      </ItemActions>
    </Item>
  );
}

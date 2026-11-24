import { LinkIcon, WalletIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar";
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
import { type ActivityEntry, Profile } from "@workspace/wallet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import {
  type Direction,
  type EntryMedia,
  type Party,
  createdWhen,
  shownEntry,
} from "@/activity/entry";
import type { AvatarTone } from "@/fixtures/types";

const tones: ReadonlyArray<AvatarTone> = ["orchid", "lila", "rosa", "durazno"];

const usernameTone = (username: string) =>
  tones[
    Array.from(username).reduce(
      (sum, letter) => sum + letter.charCodeAt(0),
      0,
    ) % tones.length
  ];

const partyKey = (party: Party) =>
  party instanceof Profile ? party.username : party.address;

export const amountTone = (direction: Direction) =>
  Match.value(direction).pipe(
    Match.when("in", () => "text-positive"),
    Match.when("out", () => "text-foreground"),
    Match.when("unchanged", () => "text-muted-foreground"),
    Match.exhaustive,
  );

export function EntryAvatar({ media }: { media: EntryMedia }) {
  if (media === "link")
    return (
      <ItemMedia variant="icon">
        <LinkIcon absoluteStrokeWidth />
      </ItemMedia>
    );

  if (media instanceof Profile)
    return (
      <ItemMedia>
        <Avatar tone={usernameTone(media.username)}>
          <AvatarFallback>
            {media.username.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </ItemMedia>
    );

  return (
    <ItemMedia variant="icon">
      <WalletIcon absoluteStrokeWidth />
    </ItemMedia>
  );
}

export function ActivityRow({
  entry,
  onOpen,
}: {
  entry: ActivityEntry;
  onOpen: () => void;
}) {
  const shown = shownEntry(entry);

  return (
    <div role="listitem">
      <Item
        size="sm"
        className="text-left"
        render={<button type="button" onClick={onOpen} />}
        data-testid="activity-row"
        data-entry={entry._tag}
        data-receipt={
          Predicate.isTagged(entry, "SentActivity")
            ? entry.receipt._tag
            : undefined
        }
        data-counterparty={Option.getOrUndefined(
          Option.map(shown.counterparty, ({ party }) => partyKey(party)),
        )}
      >
        <EntryAvatar media={shown.media} />
        <ItemContent>
          <ItemTitle>{shown.title}</ItemTitle>
          <ItemDescription>{shown.subtitle}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <div className="flex flex-col items-end gap-1">
            <span
              className={cn(
                "text-label-lg whitespace-nowrap tabular-nums",
                amountTone(shown.direction),
              )}
            >
              {shown.amount}
            </span>
            {Option.match(shown.badge, {
              onNone: () => (
                <span className="text-caption text-muted-foreground">
                  {createdWhen(shown.createdAt)}
                </span>
              ),
              onSome: (badge) => (
                <Badge variant={badge.variant}>
                  <span className="size-1.5 rounded-full bg-current" />
                  {badge.label}
                </Badge>
              ),
            })}
          </div>
        </ItemActions>
      </Item>
    </div>
  );
}

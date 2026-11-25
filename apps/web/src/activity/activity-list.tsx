import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@workspace/ui/components/drawer";
import { cn } from "@workspace/ui/lib/utils";
import { type ActivityEntry, Profile } from "@workspace/wallet";
import * as Option from "effect/Option";

import { ActivityRow, amountTone } from "@/components/activity-row";

import {
  type Party,
  createdAtLabel,
  entryKey,
  partyName,
  shownEntry,
} from "./entry";

export function ActivityList({
  entries,
}: {
  entries: ReadonlyArray<ActivityEntry>;
}) {
  const [opened, setOpened] = useState<Option.Option<ActivityEntry>>(
    Option.none(),
  );

  return (
    <>
      <div role="list" className="-mx-2 flex flex-col gap-1">
        {entries.map((entry) => (
          <ActivityRow
            key={entryKey(entry)}
            entry={entry}
            onOpen={() => setOpened(Option.some(entry))}
          />
        ))}
      </div>
      <Drawer
        open={Option.isSome(opened)}
        onOpenChange={(open) => {
          if (!open) setOpened(Option.none());
        }}
        showSwipeHandle
      >
        <DrawerContent data-testid="activity-detail">
          {Option.match(opened, {
            onNone: () => null,
            onSome: (entry) => (
              <EntryDetail
                entry={entry}
                onClose={() => setOpened(Option.none())}
              />
            ),
          })}
        </DrawerContent>
      </Drawer>
    </>
  );
}

function EntryDetail({
  entry,
  onClose,
}: {
  entry: ActivityEntry;
  onClose: () => void;
}) {
  const shown = shownEntry(entry);

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{shown.title}</DrawerTitle>
        <p
          className={cn(
            "py-2 font-display text-h1 tabular-nums",
            amountTone(shown.direction),
          )}
        >
          {shown.amount}
        </p>
        <DrawerDescription>{shown.detail}</DrawerDescription>
      </DrawerHeader>
      <dl className="flex flex-col gap-4 p-4 pt-6">
        {Option.match(shown.counterparty, {
          onNone: () => null,
          onSome: ({ label, party }) => (
            <DetailField label={label}>
              <PartyValue party={party} />
            </DetailField>
          ),
        })}
        <DetailField label="Fecha">
          {createdAtLabel(shown.createdAt)}
        </DetailField>
        {Option.match(shown.memo, {
          onNone: () => null,
          onSome: (memo) => (
            <DetailField label="Memo">
              <span className="break-all">{memo}</span>
            </DetailField>
          ),
        })}
      </dl>
      <DrawerFooter>
        {shown.openLink ? (
          <Button
            className="w-full"
            nativeButton={false}
            render={<Link to="/links" />}
          >
            Ver en Links de pago
          </Button>
        ) : null}
        <Button
          className="w-full"
          variant={shown.openLink ? "ghost" : "secondary"}
          onClick={onClose}
        >
          Cerrar
        </Button>
      </DrawerFooter>
    </>
  );
}

function DetailField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-body">{children}</dd>
    </div>
  );
}

function PartyValue({ party }: { party: Party }) {
  const [copied, setCopied] = useState(false);

  if (party instanceof Profile) return partyName(party);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(party.address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className="flex items-start gap-2">
      <span className="flex-1 font-mono text-caption break-all">
        {party.address}
      </span>
      <Button
        variant="secondary"
        size="icon"
        aria-label={copied ? "Dirección copiada" : "Copiar dirección"}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </span>
  );
}

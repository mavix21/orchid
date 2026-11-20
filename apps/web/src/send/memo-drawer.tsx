import { useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@workspace/ui/components/drawer";
import { Field, FieldError, FieldLabel } from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import * as Option from "effect/Option";

import { memoByteLimit, memoBytes } from "./intent";

export function MemoDrawer({
  open,
  memo,
  problem,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  memo: string;
  problem: Option.Option<string>;
  onOpenChange: (open: boolean) => void;
  onSave: (memo: string) => void;
}) {
  const [draft, setDraft] = useState(memo);

  useEffect(() => {
    if (open) setDraft(memo);
  }, [open, memo]);

  const save = (value: string) => {
    onSave(value);
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save(draft.trim());
          }}
        >
          <DrawerHeader>
            <DrawerTitle>Memo</DrawerTitle>
            <DrawerDescription>
              Escríbelo solo si el exchange te lo pide al depositar. Cópialo tal
              cual aparece en su pantalla.
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4">
            <Field>
              <FieldLabel htmlFor="memo">Memo</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="memo"
                  name="memo"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  aria-invalid={Option.isSome(problem) ? true : undefined}
                  aria-describedby={
                    Option.isSome(problem) ? "memo-error" : undefined
                  }
                />
                <InputGroupAddon align="inline-end">
                  <span className="text-label tabular-nums">
                    {memoBytes(draft)}/{memoByteLimit}
                  </span>
                </InputGroupAddon>
              </InputGroup>
              {Option.isSome(problem) ? (
                <FieldError id="memo-error">{problem.value}</FieldError>
              ) : null}
            </Field>
          </div>
          <DrawerFooter>
            <Button className="w-full" type="submit">
              Guardar memo
            </Button>
            {memo === "" ? null : (
              <Button
                className="w-full"
                type="button"
                variant="secondary"
                onClick={() => save("")}
              >
                Quitar memo
              </Button>
            )}
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

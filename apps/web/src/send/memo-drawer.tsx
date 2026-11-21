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
import {
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import * as Option from "effect/Option";

import { type MemoType, memoByteLimit, memoBytes } from "./intent";

const memoTypes: ReadonlyArray<{
  readonly type: MemoType;
  readonly label: string;
}> = [
  { type: "text", label: "Texto" },
  { type: "id", label: "ID numérico" },
];

export function MemoDrawer({
  open,
  memo,
  memoType,
  problem,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  memo: string;
  memoType: Option.Option<MemoType>;
  problem: Option.Option<string>;
  onOpenChange: (open: boolean) => void;
  onSave: (memo: string, memoType: Option.Option<MemoType>) => void;
}) {
  const [draft, setDraft] = useState(memo);
  const [draftType, setDraftType] = useState(memoType);

  useEffect(() => {
    if (open) {
      setDraft(memo);
      setDraftType(memoType);
    }
  }, [open, memo, memoType]);

  const save = (value: string, type: Option.Option<MemoType>) => {
    onSave(value, type);
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
            save(draft, draftType);
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
            <FieldSet className="mt-4">
              <FieldLegend variant="label">
                ¿Cómo aparece el memo en tu exchange?
              </FieldLegend>
              <div className="flex gap-2">
                {memoTypes.map(({ type, label }) => (
                  <Button
                    key={type}
                    type="button"
                    className="flex-1"
                    variant={
                      Option.contains(draftType, type) ? "default" : "secondary"
                    }
                    aria-pressed={Option.contains(draftType, type)}
                    data-testid={`memo-type-${type}`}
                    onClick={() => setDraftType(Option.some(type))}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </FieldSet>
          </div>
          <DrawerFooter>
            <Button className="w-full" type="submit" data-testid="save-memo">
              Guardar memo
            </Button>
            {memo === "" ? null : (
              <Button
                className="w-full"
                type="button"
                variant="secondary"
                onClick={() => save("", Option.none())}
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

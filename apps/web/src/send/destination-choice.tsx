import { LinkIcon, PhoneIcon, UserRoundIcon, WalletIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";

import { OptionRow } from "@/components/option-row";
import { ScreenActions, ScreenNote, ScreenStatus } from "@/components/screen";

import type { Destination, FieldProblem } from "./intent";

export type Choice = Destination | "link";

export function LinkOffer({
  problem,
  amount,
  onAccept,
  onDecline,
}: {
  problem: FieldProblem;
  amount: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <>
      <ScreenStatus title={problem.message} data-testid="link-offer">
        <ScreenNote>
          Puedes enviar {amount} con un link de pago: quien lo abra lo recibe.
          Tu dinero no se movió.
        </ScreenNote>
      </ScreenStatus>
      <ScreenActions>
        <Button className="w-full" onClick={onAccept} data-testid="offer-link">
          Enviar como link de pago
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          onClick={onDecline}
          data-testid="decline-link"
        >
          Cambiar destinatario
        </Button>
      </ScreenActions>
    </>
  );
}

export function DestinationChoice({
  onChoose,
}: {
  onChoose: (choice: Choice) => void;
}) {
  return (
    <>
      <main className="flex flex-1 flex-col gap-6 px-5 pt-2">
        <h1 className="font-display text-h1">¿A dónde lo envías?</h1>
        <div className="flex flex-col gap-3">
          <OptionRow
            title="A un @usuario"
            description="Alguien que tenga Orchid"
            media={<UserRoundIcon />}
            render={
              <button
                type="button"
                onClick={() => onChoose("username")}
                data-testid="choose-username"
              />
            }
          />
          <OptionRow
            title="A una dirección Stellar"
            description="Otra wallet o un exchange"
            media={<WalletIcon />}
            render={
              <button
                type="button"
                onClick={() => onChoose("address")}
                data-testid="choose-address"
              />
            }
          />
          <OptionRow
            title="Con un link de pago"
            description="Alguien sin Orchid"
            media={<LinkIcon />}
            render={
              <button
                type="button"
                onClick={() => onChoose("link")}
                data-testid="choose-link"
              />
            }
          />
          <OptionRow
            title="A un teléfono"
            description="Los envíos por teléfono llegan pronto"
            media={<PhoneIcon />}
            disabled
          />
        </div>
      </main>
      <ScreenActions>
        <Button
          className="w-full"
          variant="secondary"
          nativeButton={false}
          render={<Link to="/links" data-testid="open-links" />}
        >
          Ver mis links de pago
        </Button>
      </ScreenActions>
    </>
  );
}

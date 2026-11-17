import { anaqPetals } from "@/fixtures/flowers/anaq";
import { diegopPetals } from "@/fixtures/flowers/diegop";
import { luchoPetals } from "@/fixtures/flowers/lucho";
import type { Profile } from "@/fixtures/types";

export type Activity = {
  id: string;
  title: string;
  note: string;
  amount: string;
  received: boolean;

  profile?: Profile;
  time?: string;
  pending?: boolean;
};

export const recentActivity: ReadonlyArray<Activity> = [
  {
    id: "lucho-cena",
    title: "@lucho.pe",
    note: "Lo de la cena",
    amount: "+$15.00",
    received: true,
    profile: { username: "lucho.pe", tone: "durazno", petals: luchoPetals },
    time: "Hoy, 09:12",
  },
  {
    id: "link-regalo",
    title: "Link de pago",
    note: "Mi parte del regalo",
    amount: "−$20.00",
    received: false,
    pending: true,
  },
  {
    id: "diegop-taxi",
    title: "@diegop",
    note: "Gracias por el taxi",
    amount: "−$12.00",
    received: false,
    profile: { username: "diegop", tone: "orchid", petals: diegopPetals },
    time: "Ayer",
  },
  {
    id: "anaq-junta",
    title: "@anaq",
    note: "Junta de noviembre",
    amount: "+$40.00",
    received: true,
    profile: { username: "anaq", tone: "rosa", petals: anaqPetals },
    time: "Lun, 18:40",
  },
];

import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";

import { PasskeyBrowserGate } from "@/browser/passkey-browser-gate";
import { EnrollmentFlow } from "@/wallet/enrollment-flow";

export const Route = createFileRoute("/create-account")({
  component: () => (
    <PasskeyBrowserGate>
      <CreateAccount />
    </PasskeyBrowserGate>
  ),
});

function CreateAccount() {
  const { walletClient } = Route.useRouteContext();
  const navigate = useNavigate();

  const goHome = () => {
    void navigate({ to: "/home", replace: true });
  };

  return (
    <EnrollmentFlow
      title="Crea tu cuenta"
      back={(disabled) => <Link to="/" disabled={disabled} />}
      walletClient={walletClient}
      onEnrolled={goHome}
      onOpened={goHome}
    />
  );
}

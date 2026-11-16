import * as Match from "effect/Match";
import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Negative builds exercise Start's actual client import protection and package exports.
function walletBoundaryProbe(): Plugin {
  return {
    name: "wallet-boundary-probe",
    transform(code, id) {
      const probe = process.env.ORCHID_WALLET_BOUNDARY_PROBE;

      if (!probe || !id.endsWith("/src/routes/index.tsx")) return;

      const source = Match.value(probe).pipe(
        Match.when("relative", () => "../../../../packages/wallet/src/device/boundary.fixture"),
        Match.when("transport", () => "../wallet/port.functions"),
        Match.when("private", () => "@workspace/wallet/src/server/index.server"),
        Match.orElse(() => "@workspace/wallet/server"),
      );

      const symbol = probe === "transport" ? "port" : "WalletSettings";

      return `${code}\nimport { ${symbol} as boundaryValue } from "${source}"; console.log(boundaryValue);`;
    },
  };
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    walletBoundaryProbe(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({
      importProtection: { include: ["src/**", "**/packages/wallet/src/**"] },
      router: { quoteStyle: "double", semicolons: true },
    }),
    viteReact(),
  ],
});

export default config;

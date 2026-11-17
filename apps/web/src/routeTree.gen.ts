/* eslint-disable */

// @ts-nocheck

import { Route as rootRouteImport } from "./routes/__root";
import { Route as IndexRouteImport } from "./routes/index";
import { Route as CrearCuentaRouteImport } from "./routes/crear-cuenta";
import { Route as InicioRouteImport } from "./routes/inicio";
import { Route as EnviarIndexRouteImport } from "./routes/enviar/index";
import { Route as EnviarActivoRouteImport } from "./routes/enviar/$activo";

const IndexRoute = IndexRouteImport.update({
  id: "/",
  path: "/",
  getParentRoute: () => rootRouteImport,
} as any);
const CrearCuentaRoute = CrearCuentaRouteImport.update({
  id: "/crear-cuenta",
  path: "/crear-cuenta",
  getParentRoute: () => rootRouteImport,
} as any);
const InicioRoute = InicioRouteImport.update({
  id: "/inicio",
  path: "/inicio",
  getParentRoute: () => rootRouteImport,
} as any);
const EnviarIndexRoute = EnviarIndexRouteImport.update({
  id: "/enviar/",
  path: "/enviar/",
  getParentRoute: () => rootRouteImport,
} as any);
const EnviarActivoRoute = EnviarActivoRouteImport.update({
  id: "/enviar/$activo",
  path: "/enviar/$activo",
  getParentRoute: () => rootRouteImport,
} as any);

export interface FileRoutesByFullPath {
  "/": typeof IndexRoute;
  "/crear-cuenta": typeof CrearCuentaRoute;
  "/inicio": typeof InicioRoute;
  "/enviar/$activo": typeof EnviarActivoRoute;
  "/enviar/": typeof EnviarIndexRoute;
}
export interface FileRoutesByTo {
  "/": typeof IndexRoute;
  "/crear-cuenta": typeof CrearCuentaRoute;
  "/inicio": typeof InicioRoute;
  "/enviar/$activo": typeof EnviarActivoRoute;
  "/enviar": typeof EnviarIndexRoute;
}
export interface FileRoutesById {
  __root__: typeof rootRouteImport;
  "/": typeof IndexRoute;
  "/crear-cuenta": typeof CrearCuentaRoute;
  "/inicio": typeof InicioRoute;
  "/enviar/$activo": typeof EnviarActivoRoute;
  "/enviar/": typeof EnviarIndexRoute;
}
export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath;
  fullPaths: "/" | "/crear-cuenta" | "/inicio" | "/enviar/$activo" | "/enviar/";
  fileRoutesByTo: FileRoutesByTo;
  to: "/" | "/crear-cuenta" | "/inicio" | "/enviar/$activo" | "/enviar";
  id:
    | "__root__"
    | "/"
    | "/crear-cuenta"
    | "/inicio"
    | "/enviar/$activo"
    | "/enviar/";
  fileRoutesById: FileRoutesById;
}
export interface RootRouteChildren {
  IndexRoute: typeof IndexRoute;
  CrearCuentaRoute: typeof CrearCuentaRoute;
  InicioRoute: typeof InicioRoute;
  EnviarActivoRoute: typeof EnviarActivoRoute;
  EnviarIndexRoute: typeof EnviarIndexRoute;
}

declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/": {
      id: "/";
      path: "/";
      fullPath: "/";
      preLoaderRoute: typeof IndexRouteImport;
      parentRoute: typeof rootRouteImport;
    };
    "/crear-cuenta": {
      id: "/crear-cuenta";
      path: "/crear-cuenta";
      fullPath: "/crear-cuenta";
      preLoaderRoute: typeof CrearCuentaRouteImport;
      parentRoute: typeof rootRouteImport;
    };
    "/inicio": {
      id: "/inicio";
      path: "/inicio";
      fullPath: "/inicio";
      preLoaderRoute: typeof InicioRouteImport;
      parentRoute: typeof rootRouteImport;
    };
    "/enviar/": {
      id: "/enviar/";
      path: "/enviar";
      fullPath: "/enviar/";
      preLoaderRoute: typeof EnviarIndexRouteImport;
      parentRoute: typeof rootRouteImport;
    };
    "/enviar/$activo": {
      id: "/enviar/$activo";
      path: "/enviar/$activo";
      fullPath: "/enviar/$activo";
      preLoaderRoute: typeof EnviarActivoRouteImport;
      parentRoute: typeof rootRouteImport;
    };
  }
}

const rootRouteChildren: RootRouteChildren = {
  IndexRoute: IndexRoute,
  CrearCuentaRoute: CrearCuentaRoute,
  InicioRoute: InicioRoute,
  EnviarActivoRoute: EnviarActivoRoute,
  EnviarIndexRoute: EnviarIndexRoute,
};
export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>();

import type { getRouter } from "./router.tsx";
import type { createStart } from "@tanstack/react-start";
declare module "@tanstack/react-start" {
  interface Register {
    ssr: true;
    router: Awaited<ReturnType<typeof getRouter>>;
  }
}

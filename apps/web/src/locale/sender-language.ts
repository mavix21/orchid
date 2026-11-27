import {
  type Locale,
  cookieName,
  defineCustomClientStrategy,
  defineCustomServerStrategy,
  isLocale,
} from "@/paraglide/runtime";

const parameter = "lang";
const strategy = "custom-senderLanguage";
const paymentLinkPage = "/r";

export const senderLanguageQuery = (locale: Locale) =>
  new URLSearchParams([[parameter, locale]]).toString();

export const inSenderLanguage = (url: URL, locale: Locale) => {
  const carried = new URL(url);

  carried.searchParams.set(parameter, locale);

  return carried;
};

const senderLocale = (url: URL) => {
  const carried = url.searchParams.get(parameter);

  return url.pathname === paymentLinkPage && isLocale(carried)
    ? carried
    : undefined;
};

const holdsChosenLocale = (request: Request) =>
  (request.headers.get("cookie") ?? "").split(";").some((entry) => {
    const [name, value] = entry.trim().split("=");

    return name === cookieName && isLocale(value);
  });

export const registerSenderLanguageOnServer = () =>
  defineCustomServerStrategy(strategy, {
    getLocale: (request) =>
      request === undefined || holdsChosenLocale(request)
        ? undefined
        : senderLocale(new URL(request.url)),
  });

export const registerSenderLanguageInBrowser = () =>
  defineCustomClientStrategy(strategy, {
    getLocale: () => senderLocale(new URL(window.location.href)),
    setLocale: () => undefined,
  });

import * as Data from "effect/Data";

export type EmbeddedApp = "Instagram" | "Facebook" | "TikTok" | "WhatsApp";

export type DevicePlatform = "android" | "ios" | "other";

export type BrowserSupport = Data.TaggedEnum<{
  Supported: {};
  EmbeddedBrowser: {
    readonly app: EmbeddedApp;
    readonly platform: DevicePlatform;
  };
  OutdatedIos: {};
}>;

export const BrowserSupport = Data.taggedEnum<BrowserSupport>();

const embeddedApps: ReadonlyArray<readonly [EmbeddedApp, RegExp]> = [
  ["Instagram", /Instagram/],
  ["Facebook", /FBAN|FBAV|FB_IAB/],
  ["TikTok", /BytedanceWebview|musical_ly/],
  ["WhatsApp", /WhatsApp/],
];

const minimumIosVersion = { major: 18, minor: 4 };

const platformOf = (userAgent: string): DevicePlatform =>
  /iPhone|iPad|iPod/.test(userAgent)
    ? "ios"
    : /Android/.test(userAgent)
      ? "android"
      : "other";

const isOutdatedIos = (userAgent: string) => {
  const version = /(?:iPhone|CPU) OS (\d+)_(\d+)/.exec(userAgent);

  if (version === null) return false;

  const major = Number(version[1]);
  const minor = Number(version[2]);

  return (
    major < minimumIosVersion.major ||
    (major === minimumIosVersion.major && minor < minimumIosVersion.minor)
  );
};

export function classifyBrowser(userAgent: string): BrowserSupport {
  if (isOutdatedIos(userAgent)) return BrowserSupport.OutdatedIos();

  const embedded = embeddedApps.find(([, marker]) => marker.test(userAgent));

  return embedded === undefined
    ? BrowserSupport.Supported()
    : BrowserSupport.EmbeddedBrowser({
        app: embedded[0],
        platform: platformOf(userAgent),
      });
}

export function androidDefaultBrowserLink(destination: string) {
  const url = new URL(destination);

  return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=${url.protocol.slice(0, -1)};end`;
}

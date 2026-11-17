import { createCn } from "cn/config";

// Teach the merger the Orchid theme scales so `text-h1` is a font size, not a color.
export const cn = createCn({
  extend: {
    theme: {
      text: [
        "display-balance",
        "display-amount",
        "h1",
        "h2",
        "h3",
        "body-lg",
        "body",
        "body-strong",
        "label-lg",
        "label",
        "label-sm",
        "caption",
        "numeric-lg",
        "numeric",
        "keypad",
      ],
      shadow: ["raised", "overlay"],
      font: ["display"],
    },
  },
});

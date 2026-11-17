import { createCn } from "cn/config";

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

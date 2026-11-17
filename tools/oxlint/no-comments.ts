import { definePlugin, defineRule } from "@oxlint/plugins";

export default definePlugin({
  meta: { name: "orchid" },
  rules: {
    "no-comments": defineRule({
      meta: {
        type: "problem",
        schema: [],
        messages: {
          forbidden:
            "Remove this comment. Express meaning through clear names, domain terminology, and code structure.",
        },
      },
      createOnce(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              context.report({ loc: comment.loc, messageId: "forbidden" });
            }
          },
        };
      },
    }),
  },
});

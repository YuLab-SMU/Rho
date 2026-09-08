import { expect, it } from "vitest";
import { parser } from "@codincod/codemirror-lang-r";
import { locallyIncomplete, isR } from "../src/r-language";
it.each([
  "x |> mean()",
  "x %>% f(a = 1)",
  "`a b` %custom% 数据",
  "\\(x) x + 1",
  "stats::lm(y ~ x, data = df)",
  "x[, , drop = FALSE]",
  'r"---(a\\b)---"',
  "f <- function(x, ...) { TRUE; NA_real_; 1i }",
])("parses representative R: %s", (code) => {
  let errors = 0;
  parser.parse(code).iterate({
    enter(n) {
      if (n.type.isError) errors++;
    },
  });
  expect(errors).toBe(0);
});
it.each(["x <-", "function(x) {", 'r"---(hello', "mean("])(
  "continues incomplete input: %s",
  (code) => expect(locallyIncomplete(code)).toBe(true),
);
it("keeps non-R files plain", () => {
  expect(isR("notes.txt")).toBe(false);
  expect(isR("中文.R")).toBe(true);
});

import { describe, expect, it } from "vitest";

import { sourceExecutionAt, sourceGapNavigationAt } from "./source-execution";

describe("Source editor execution scope", () => {
  it("returns a literal executable selection without moving its cursor", () => {
    expect(sourceExecutionAt("alpha\nbeta\ngamma", 6, 10)).toEqual({
      kind: "selection",
      code: "beta",
      start: 6,
      end: 10,
      range: { start_line: 2, start_column: 1, end_line: 2, end_column: 5 },
      next_cursor: null,
    });
  });

  it("returns one complete LF expression and advances to the next line", () => {
    expect(sourceExecutionAt("alpha\nbeta\ngamma", 8, 8)).toEqual({
      kind: "expression",
      code: "beta",
      start: 6,
      end: 10,
      range: { start_line: 2, start_column: 1, end_line: 2, end_column: 5 },
      next_cursor: 11,
    });
  });

  it("keeps CRLF out of code and advances after the complete delimiter", () => {
    expect(sourceExecutionAt("alpha\r\nbeta\r\ngamma", 9, 9)).toEqual({
      kind: "expression",
      code: "beta",
      start: 7,
      end: 11,
      range: { start_line: 2, start_column: 1, end_line: 2, end_column: 5 },
      next_cursor: 13,
    });
  });

  it("clamps final-line advancement to the document end", () => {
    expect(sourceExecutionAt("alpha\nbeta", 9, 9)).toEqual({
      kind: "expression",
      code: "beta",
      start: 6,
      end: 10,
      range: { start_line: 2, start_column: 1, end_line: 2, end_column: 5 },
      next_cursor: 10,
    });
  });

  it("resolves the complete nested R expression from every cursor line", () => {
    const value = [
      "before <- 1",
      "df <- do.call(rbind, lapply(c(\"A\", \"B\", \"C\"), function(g) {",
      "  intercept <- switch(g,",
      "    A = 2,",
      "    B = 5,",
      "    C = 8",
      "  )",
      "  data.frame(",
      "    x = runif(34, 0, 10),",
      "    y = intercept + 0.8 * runif(34, 0, 10),",
      "    group = g",
      "  )",
      "}))",
      "after <- 2",
    ].join("\n");
    const expressionStart = value.indexOf("df <-");
    const expressionEnd = value.indexOf("\nafter <- 2");
    const expectedCode = value.slice(expressionStart, expressionEnd);
    for (const needle of ["df <-", "intercept <-", "A = 2", "data.frame(", "group = g", "}))"]) {
      const cursor = value.indexOf(needle);
      expect(sourceExecutionAt(value, cursor, cursor)).toEqual({
        kind: "expression",
        code: expectedCode,
        start: expressionStart,
        end: expressionEnd,
        range: { start_line: 2, start_column: 1, end_line: 13, end_column: 4 },
        next_cursor: expressionEnd + 1,
      });
    }
  });

  it("keeps trailing operators and custom infix pipelines in one expression", () => {
    const plot = "p <- ggplot(df) +\n  geom_point() + # layer\n  theme_minimal()\nprint(p)";
    expect(sourceExecutionAt(plot, plot.indexOf("geom_point"), plot.indexOf("geom_point")))
      .toMatchObject({
        kind: "expression",
        code: "p <- ggplot(df) +\n  geom_point() + # layer\n  theme_minimal()",
        range: { start_line: 1, start_column: 1, end_line: 3, end_column: 18 },
        next_cursor: plot.indexOf("print(p)"),
      });
    const pipeline = "result <- data %custom>%\n  transform(x = x + 1)\nresult";
    expect(sourceExecutionAt(pipeline, pipeline.indexOf("transform"), pipeline.indexOf("transform"))?.code)
      .toBe("result <- data %custom>%\n  transform(x = x + 1)");
  });

  it("ignores delimiters and comments inside strings and backticks", () => {
    const value = "x <- list(\n  text = \"}) # still text\",\n  `odd)name` = '# value' # real comment\n)\ny <- 2";
    const execution = sourceExecutionAt(value, value.indexOf("odd)name"), value.indexOf("odd)name"));
    expect(execution?.code).toBe(value.slice(0, value.indexOf("\ny <- 2")));
    expect(execution?.next_cursor).toBe(value.indexOf("y <- 2"));
  });

  it("keeps a following else branch with its if expression", () => {
    const value = "if (ready) {\n  run()\n}\n# bridge\nelse {\n  wait()\n}\nnext_step()";
    const execution = sourceExecutionAt(value, value.indexOf("run()"), value.indexOf("run()"));
    expect(execution?.code).toBe(value.slice(0, value.indexOf("\nnext_step")));
    expect(execution?.next_cursor).toBe(value.indexOf("next_step"));
  });

  it("rejects an incomplete or structurally invalid expression before admission", () => {
    const incomplete = "df <- data.frame(\n  x = 1\n";
    expect(sourceExecutionAt(incomplete, 0, 0)).toBeNull();
    expect(sourceExecutionAt("value <- 1)\nnext <- 2", 0, 0)).toBeNull();
  });

  it("reports exact one-based UTF-16 selection columns", () => {
    const value = "alpha\nemoji <- \"🧪\"\nomega";
    const start = value.indexOf("🧪");
    const end = start + "🧪".length;
    expect(sourceExecutionAt(value, start, end)?.range).toEqual({
      start_line: 2,
      start_column: 11,
      end_line: 2,
      end_column: 13,
    });
  });

  it("rejects empty and whitespace-only line or selection requests", () => {
    expect(sourceExecutionAt("alpha\n   \ngamma", 8, 8)).toBeNull();
    expect(sourceExecutionAt("alpha\n   \ngamma", 6, 9)).toBeNull();
    expect(sourceExecutionAt("", 0, 0)).toBeNull();
  });

  it("rejects pure comments before they can pollute execution History", () => {
    const value = "# ---- generate data ----\nset.seed(42)";
    expect(sourceExecutionAt(value, 3, 3)).toBeNull();
    expect(sourceExecutionAt(value, 0, value.indexOf("\n"))).toBeNull();
    expect(sourceExecutionAt("value <- '# executable string'", 0, 0)?.code)
      .toBe("value <- '# executable string'");
  });

  it("skips blank and comment-only gaps after an expression", () => {
    const value = "library(ggplot2)\n   \n# generate data\n\t# more context\nset.seed(42)";
    expect(sourceExecutionAt(value, 0, 0)?.next_cursor).toBe(value.indexOf("set.seed"));
    expect(sourceGapNavigationAt(value, value.indexOf("   "), value.indexOf("   ")))
      .toBe(value.indexOf("set.seed"));
    expect(sourceGapNavigationAt(value, value.indexOf("generate"), value.indexOf("generate")))
      .toBe(value.indexOf("set.seed"));
  });

  it("navigates CRLF and terminal gaps without creating an execution", () => {
    const value = "alpha\r\n\r\n# divider\r\nbeta\r\n";
    const blank = value.indexOf("\r\n") + 2;
    expect(sourceGapNavigationAt(value, blank, blank)).toBe(value.indexOf("beta"));
    expect(sourceGapNavigationAt(value, value.length, value.length)).toBe(value.length);
    expect(sourceGapNavigationAt(value, blank, value.indexOf("beta"))).toBeNull();
  });

  it("does not terminate a continued expression at an intervening blank line", () => {
    const value = "result <- data |>\n\n  transform(x = x + 1)\nnext_value <- 2";
    expect(sourceExecutionAt(value, value.indexOf("result"), value.indexOf("result"))?.code)
      .toBe("result <- data |>\n\n  transform(x = x + 1)");
  });

  it("orders and clamps selection offsets", () => {
    expect(sourceExecutionAt("alpha\nbeta", 99, 6)).toEqual({
      kind: "selection",
      code: "beta",
      start: 6,
      end: 10,
      range: { start_line: 2, start_column: 1, end_line: 2, end_column: 5 },
      next_cursor: null,
    });
  });
});

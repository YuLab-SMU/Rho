import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPurpose, selectionCode, statementAt, statements, unfinished } from '../dist/statements.js';

const r = `# Ozone and weather
aq <- read.csv("data/airquality.csv")
str(aq)

fit <- lm(Ozone ~ Temp + Wind, data = complete)
plot(complete$Temp, complete$Ozone,
     xlab = "Temperature (F)", ylab = "Ozone (ppb)")
abline(lm(Ozone ~ Temp, data = complete), col = "firebrick")
d <- aq |>
  subset(!is.na(Ozone)) |> # a comment ( with a bracket
  transform(hot = Temp > 80)
if (TRUE) print("one line")
f <- function(x)
  x + 1
g <- function(x) {
  y <- x * 2  # ")"
  y
}
s <- "a string
over two lines"
`;

test('R statements span calls over lines, pipes, functions and strings', () => {
  assert.deepEqual(statements(r, 'r'), [
    { from: 2, to: 2 }, { from: 3, to: 3 }, { from: 5, to: 5 }, { from: 6, to: 7 }, { from: 8, to: 8 }, { from: 9, to: 11 },
    { from: 12, to: 12 }, { from: 13, to: 14 }, { from: 15, to: 18 }, { from: 19, to: 20 },
  ]);
  const plot = statementAt(r, 7, 'r');
  assert.equal(plot.statement.code, 'plot(complete$Temp, complete$Ozone,\n     xlab = "Temperature (F)", ylab = "Ozone (ppb)")', 'the cursor on a call\'s second line runs the whole call');
  assert.equal(plot.next, 8, 'the cursor goes on to the next statement');
  assert.deepEqual(statementAt(r, 4, 'r'), { statement: null, next: 5 }, 'a blank line runs nothing and moves on');
  assert.deepEqual(statementAt(r, 1, 'r'), { statement: null, next: 2 }, 'so does a comment');
  assert.equal(statementAt(r, 16, 'r').statement.from, 15, 'a line inside a function runs the function');
  assert.equal(statementAt(r, 20, 'r').next, null, 'the last statement has none after it');
});

const py = `import pandas as pd

@dataclass
class Point:
    x: int

    def norm(self):
        return abs(self.x)

for i in range(3):
    print(i)
else:
    print("done")
try:
    risky()
except ValueError:
    pass
if ok: a = 1
else: a = 2
total = (1 +
         2)
s = """one
two"""
`;

test('Python statements take blocks, decorators, clauses and brackets', () => {
  assert.deepEqual(statements(py, 'python'), [
    { from: 1, to: 1 }, { from: 3, to: 8 }, { from: 10, to: 13 }, { from: 14, to: 17 }, { from: 18, to: 19 }, { from: 20, to: 21 }, { from: 22, to: 23 },
  ]);
  assert.equal(statementAt(py, 8, 'python').statement.from, 3, 'a line in a method runs its decorated class');
  assert.equal(statementAt(py, 11, 'python').next, 14);
  assert.equal(selectionCode('    return abs(self.x)\n    pass', 'python'), 'return abs(self.x)\npass', 'a selection inside a block is moved left');
  assert.equal(selectionCode('  x <- 1', 'r'), '  x <- 1');
  assert.equal(runPurpose('code/analysis.R', 6, 7), 'analysis.R · lines 6–7');
  assert.equal(runPurpose('analysis.R', 3, 3), 'analysis.R · line 3');
});

test('at a console prompt, Enter runs finished code and goes on to another line in unfinished code', () => {
  for (const code of ['x <- 1', 'summary(aq)', 'f <- function(x) {\n  x + 1\n}', 'd |>\n  head()', '# just a comment', '']) assert.equal(unfinished(code, 'r'), false, code);
  for (const code of ['plot(x,', 'f <- function(x) {', 'd |>', 'x <- "a string', 'f <- function(x)', 'y <- 1 +  # more']) assert.equal(unfinished(code, 'r'), true, code);
  for (const code of ['x = 1', 'if ok: a = 1', 'for v in xs:\n    print(v)\n', 'total = (1 +\n  2)']) assert.equal(unfinished(code, 'python'), false, code);
  for (const code of ['for v in xs:', 'for v in xs:\n    print(v)', 'def f(x):\n    return x', 'total = (1 +', 's = """one']) assert.equal(unfinished(code, 'python'), true, code);
});

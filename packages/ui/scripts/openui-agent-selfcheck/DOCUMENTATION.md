# Ownership

These standalone helpers validate candidate Markdown and inspect final responses.
The UI component catalog owns DSL validation. Product entry points do not import
these helpers; they do not enforce a runtime gate or trigger Agent retries.

# Invariants

- A candidate contains one complete Markdown code fence labelled `openui-lang`.
  Validation covers its envelope, the existing finished-block parser, and each
  evaluated Table row having exactly as many cells as its columns.
- Neither the candidate nor the final answer is corrected by these scripts.
- Audits preserve both the original file and the exact fenced span. Only outer
  Markdown separator newlines lie outside the compared span.
- Candidate validity and final-fragment equality are separate results.
- `inspectFinal` uses actual Markdown code nodes, so a nested teaching example
  inside another code fence cannot count as an inline UI block.

# Decisions

## Why check evaluated table widths

The catalog validates Table prop types without requiring each row to match its
column count. Checking the evaluated widths rejects that mismatch while keeping
the original candidate and parser unchanged.

## Why parse the envelope as Markdown

A valid Stack body can still be unfenced, unlabelled, or embedded in a teaching
example. Validating only the DSL would report success for those failures. The
Markdown AST supplies the actual code nodes and their original source offsets.

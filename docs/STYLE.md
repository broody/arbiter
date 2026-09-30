# Writing the referee docs

The site is [Vocs](https://vocs.dev) v2: pages are MDX in `src/pages`, and the
sidebar is in `vocs.config.ts`. `npm run build` fails on dead links.

## Voice

- Plain, precise English. Short sentences, present tense. Guides speak to the
  reader ("you"); concepts and reference describe the system.
- Every claim comes from the source in this repository. Don't document an API,
  option or behavior you haven't read in the code; link to the file when it helps
  (`https://github.com/broody/referee/blob/main/<path>`).
- Name things as the code does: `Session.receive`, `submit_history`,
  `support_turn`. Use code formatting for identifiers, values and paths.
- The protocol supports 2 seats today; N-player support is in progress. Say
  "2 seats" only where the code assumes it, and don't speculate about N players.

## Page shape

- Start with `# Title`, then one or two sentences on what the page covers and
  who needs it.
- Use `##` sections. Prefer tables for listings (API: Name | Signature | What it
  does) and numbered lists for sequences.
- Diagrams are fenced ```` ```mermaid ```` blocks (flowchart, sequenceDiagram,
  stateDiagram-v2). Keep labels short.
- Callouts: `:::note`, `:::tip`, `:::warning`, `:::danger`, closed with `:::`.
  Use them sparingly, for things a reader must not miss.
- Sequences of commands: `:::steps` with `###` headings inside.
- Code blocks carry a language: `ts`, `js`, `cairo`, `bash`, `json`.
- Link pages by absolute path without extension: `[The channel](/concepts/channel)`.

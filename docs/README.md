# haiflow documentation site

The developer documentation for [haiflow](https://github.com/andersonaguiar/haiflow), built with [Mintlify](https://mintlify.com).

Content lives as MDX pages, navigation is defined in `docs.json`, and the full REST API reference is generated from `openapi.json` (so the spec stays the single source of truth and renders an interactive playground).

## Structure

```
docs/
├── docs.json                  # Mintlify config: theme, navigation, search
├── openapi.json               # OpenAPI 3.1 spec → interactive API reference
├── introduction.mdx           # Landing page
├── quickstart.mdx
├── installation.mdx
├── configuration.mdx
├── concepts/                  # Architecture, sessions, queueing, ledger, context
├── guides/                    # CLI, dashboard, pipelines, pools, webhooks, security guides
├── integrations/              # MCP server, n8n nodes
├── api-reference/             # API overview (endpoints auto-generated from openapi.json)
├── deployment.mdx
├── security.mdx
├── logo/                      # light/dark logos
└── favicon.svg
```

## Preview locally

Mintlify previews with its CLI (Node 19+ required):

```bash
npm i -g mint        # one-time
cd docs
mint dev             # serves http://localhost:3000
```

Check for broken internal links and bad OpenAPI references:

```bash
cd docs
mint broken-links
```

> No global install? Use `npx mint@latest dev` from the `docs/` directory.

## Edit content

- **Add a page:** create a `.mdx` file with `title` / `description` frontmatter, then add its path (without the `.mdx` extension) to the right group in `docs.json` under `navigation.tabs[].groups[].pages[]`.
- **Change the API reference:** edit `openapi.json`. Endpoints are grouped in the sidebar by their `tags`. Keep it in sync with the server routes in `src/index.ts` and `API.md`.
- **Components:** pages use [Mintlify components](https://mintlify.com/docs/components) (`Card`, `Steps`, `Tabs`, `Note`, `Warning`, `Accordion`, ...).

## Deploy

Mintlify deploys from a connected GitHub repository. Connect this repo (or a docs subtree) in the [Mintlify dashboard](https://dashboard.mintlify.com) and point it at the `docs/` directory. Every push to the default branch publishes automatically.

Any static-friendly alternative also works, since the content is plain MDX plus an OpenAPI spec.

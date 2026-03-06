# Contributing

Thanks for your interest in contributing to this project!

## How to contribute

1. **Open an issue first** — describe the bug, feature, or improvement you have in mind.
2. **Fork the repo** and create a feature branch from `main`.
3. **Match the existing style** — clear names, small functions, minimal magic.
4. **Test your changes** — include verification steps or test commands in your PR description.
5. **Submit a pull request** — reference the issue and describe what you changed and why.

## Development setup

```bash
# PBX (Asterisk in Docker)
cp .env.example .env
# Fill in your values, then:
docker compose -f compose/docker-compose.dev.yml up --build

# Realtime bridge (Node.js)
cd realtime-bridge
npm install
cp .env.example .env   # if applicable
npm run dev
```

## Code style

- **Asterisk configs**: follow the existing template/comment style.
- **JavaScript** (realtime-bridge): ESLint + Prettier are configured — run `npm run lint` and `npm run format`.
- **Ansible**: standard YAML style, idempotent tasks.
- **Docs**: keep the layered structure (README → RUNBOOK → ARCHITECTURE → docs/).

## Reporting bugs

Please include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Relevant logs (sanitise any secrets)

## Scope

This is a portfolio/lab project. Contributions that improve documentation, fix bugs, add tests, or improve the developer experience are especially welcome.

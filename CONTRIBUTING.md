# Contributing to Mux

Contributions are welcome! Before opening a PR or issue, please check the current state of the repo.

## Development Setup

```bash
git clone https://github.com/arniesaha/mux.git
cd mux
npm install
cp .env.example .env
npm run dev
```

## Testing

```bash
npm test
```

## Code Style

- Run `npm test` before committing
- Keep routing logic in `src/`; downstream adapters in `src/downstream/`

## Submitting Changes

1. Fork the repo
2. Create a feature branch from `master`
3. Make your changes with test coverage
4. Open a PR targeting `master`

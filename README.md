# az-dashboard

sol's Accelerator-Z projects, live from Zenon mainnet, with voting through the
Syrius extension for Pillars.

Live: <https://az.zenon.foo/>

```console
python -m http.server 8147   # then open http://localhost:8147
```

Each project's status, links and changelog are in `projects.json`, keyed by project
id. Everything else is read from the chain. Pushing to `main` publishes the page
(`.github/workflows/pages.yml`).

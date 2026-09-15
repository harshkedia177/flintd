# flintd documentation

Start here if you are past the [README](../README.md).

## Getting started

| Page | For whom |
| --- | --- |
| [SDK quickstart](quickstarts/sdk.md) | you are writing your own agent loop. No daemon |
| [Daemon quickstart](quickstarts/daemon.md) | you are connecting a coding agent you did not write |
| [Quickstarts index](quickstarts) | one page per harness, one per SDK and provider |

## Reference

| Page | What it holds |
| --- | --- |
| [REST contract](rest-contract.md) | the wire contract every client implements. The source of truth for every claim in this project |
| [Configuration](config.md) | every `config.json` key, its type, its default and the `createFlint` option it maps to |
| [Security](security.md) | the three tiers, the Manifest, the Approval, the Proxy, and an explicit list of what flintd does not promise |
| [Observer](observer.md) | what it reads, what consent gates it, and what it stores |
| [Evals](evals.md) | the free gate lane and the paid lane, what a run costs, and the thresholds |

## Background

| Page | What it holds |
| --- | --- |
| [Glossary](../CONTEXT.md) | the words this project uses, and the synonyms it refuses |
| [Changelog](../CHANGELOG.md) | what is in this release |

## Contributing

[CONTRIBUTING.md](../CONTRIBUTING.md) covers the gate you must pass and how to run it.
[SECURITY.md](../SECURITY.md) has the private route for a vulnerability report.

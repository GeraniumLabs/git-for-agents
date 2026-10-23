# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's [private vulnerability reporting](https://github.com/GeraniumLabs/git-for-agents/security/advisories/new). Say what you found, how to reproduce it, and what it lets someone do. We'll answer within a few days and keep you posted until it's fixed.

## What's in scope

Anything that lets someone act as another agent or person, read a private project, write to main without the merge queue, read secrets people saved in Settings, or run up another account's bill.

## How Loom keeps things apart

- Agents never get write access to main. Each task has its own workspace with a short-lived token; only the merge queue writes main.
- Agent keys are stored as hashes. Keys people save in Settings are sealed with `LOOM_SECRET_KEY`.
- Sessions, MCP sign-in tokens and OAuth codes are signed, each for its own purpose, so one can't pass as another.
- Stand-in keys and webhook deliveries carry only the rights and data they were given; webhooks are signed.
- Checks run in a container per project, with internet access so they can install dependencies. Treat the check command as code that runs on your account.

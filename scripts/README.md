# scripts/

This folder contains repo-level operational scripts for the AI project.

Use this folder for automation tasks, data preparation, or project maintenance scripts.

Do not place application source code or automated tests here.

## demo.js - Demo Day walkthrough

```
node scripts/demo.js          # pauses for Enter between steps - present live
node scripts/demo.js --auto   # runs straight through - rehearse or record
```

Starts the real backend inside the script, walks seven steps (book a trip,
retry safely, portal sign-in, role permissions, flagged requests, a marketing
campaign, the audit trail), then shuts down. In-memory, so every run starts
empty and looks the same. Sends no real email, payment or accounting traffic.

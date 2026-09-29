# mcp-server

An MCP server, built in **Python**. Right now it is deliberately empty: it starts,
it can say "hello, I exist", and that is all. Nothing has been added to it yet.

This page tells you how to start it and what you should see. You do not need to
know any programming to follow it.

---

## What "starting the server" actually means

This server is reached over **HTTP**, which means it has a web address:

```
http://127.0.0.1:8000/mcp
```

It is still a program that sits in a terminal window and waits to be spoken to
by a *client* (for example Claude Code). But unlike before, there is now an
address for a client to connect to.

**Do not expect anything useful in a browser.** If you paste that address into
Chrome you will get an error page saying `Bad Request`. That is correct, not
broken — the address only speaks the language MCP clients speak, and a browser
does not speak it.

**About that address:** `127.0.0.1` is a special address meaning *this computer
only*. Nobody else on the network, and nobody on the internet, can reach it. That
is deliberate for now. Letting other people in is a separate piece of work — see
"About other people using this" at the bottom.

---

## Before the first time only

You need a tool called `uv`. It is already installed on this machine, so there is
nothing to do. If you ever move to a different computer, check it by typing:

```
uv --version
```

If that prints a version number, you are ready. If it says `uv` is not
recognised, `uv` needs installing first.

---

## The command to start it

**This command has changed.** The server now talks to the travel backend, so it
needs to be told where that backend is and given a password for it. There are
four lines now instead of two.

Open a terminal (PowerShell). Type these lines, pressing Enter after each.

**Line 1 — move into the right folder:**

```
cd C:\Users\Mems\Documents\AI-Project\mcp-server
```

**Line 2 — say where the travel backend is:**

```
$env:COLABERRY_API_BASE_URL="http://127.0.0.1:3001"
```

**Line 3 — give it the password for the backend:**

```
$env:COLABERRY_API_TOKEN="tok-mcp-dev-12345"
```

**Line 4 — start the server:**

```
uv run --with "mcp[cli]" --with "httpx2" python src/server.py
```

The quote marks matter. Please type these exactly as shown.

**Why lines 2 and 3 are separate from the program:** the token on line 3 is a
password. Passwords typed into a program file get copied, shared and uploaded by
accident. Typed into the terminal, they vanish when you close the window.

**A warning you may see.** If you skip line 3, the server still starts but prints:

```
  WARNING: COLABERRY_API_TOKEN is not set. get_safari_details
  will return 'not_configured' until it is.
```

That is the server telling you the tool will not work. Stop it, run line 3, and
start it again.

---

## The travel backend has to be running too

The tool asks the travel backend for its answers, so that backend needs to be
running as well — in a **separate terminal window**, left open.

```
cd C:\Users\Mems\Documents\AI-Project
$env:COLABERRY_API_TOKENS="tok-mcp-dev-12345:advisor:ADV-1"
$env:PORT="3001"
node backend/src/http/start.js
```

Note the name on the backend side is `COLABERRY_API_TOKENS` — **plural**, and
with the role and user attached. That is a different variable from the one on
line 3 above, even though the token itself is the same string.

You will know it worked when a line appears containing `"event":"listening"`.

If you forget this step, nothing breaks — the tool simply answers that the
backend is unreachable. See "What happens when the backend is down" below.

---

## Exactly what you should see

**This is the part that changed.** The old version of this page said that one
line appears and then nothing else, and that lots of text meant something was
wrong. That is no longer true. You should now see roughly eight lines, and that
is success.

```
my-mcp-server starting on http://127.0.0.1:8000/mcp
Press Ctrl+C to stop.
INFO:     Started server process [23048]
INFO:     Waiting for application startup.
[09/08/26 18:03:33] INFO     StreamableHTTP      streamable_http_manager.py:162
                             session manager
                             started
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

**The line that confirms it worked is the last one:**

```
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

If you see that, the server is up and listening.

The number in `[23048]` will be different every time. That is normal — it is
just an ID the computer gives the program.

**On the very first run only**, you may see one extra line *above* everything
else, like:

```
Installed 38 packages in 402ms
```

That is `uv` fetching the MCP software the first time. It is normal, it happens
once, and you can ignore it.

After the last line the cursor sits there and nothing further happens. Leave the
window open for as long as you want the server running.

**One more difference from before:** the window is no longer silent while it
runs. Every time a client connects or asks the server something, another `INFO`
line appears. That is the server narrating what it is doing, and it is a good
sign, not a problem.

---

## How to stop it

Click on the terminal window, then hold **Ctrl** and press **C**.

You are returned to a normal prompt. Closing the window also stops it.

---

## If it does not work

| What you see | What it means | What to do |
|---|---|---|
| `uv : The term 'uv' is not recognized...` | The terminal cannot find `uv`. | Close the terminal, open a fresh one, and try again. If it persists, `uv` needs reinstalling. |
| `can't open file 'src/server.py'` or `No such file or directory` | You are in the wrong folder. | Run Line 1 again exactly as written, then Line 2. |
| `error while attempting to bind on address` or `address already in use` | The server is **already running** in another window. Only one copy can use the address at a time. | Find the other terminal window and press Ctrl+C in it. Then try again. |
| A window flashes open and shuts instantly | You double-clicked `server.py` instead of using a terminal. | This program can only be started from a terminal, using the two lines above. |
| Nothing at all appears, not even one line | The command did not run. | Check for a typo in Line 2, especially the quote marks around `"mcp[cli]"`. |
| `Bad Request` in your browser | You visited the address in a browser. | This is expected. The address is for MCP clients, not for browsers. Nothing is wrong. |
| A wall of red text mentioning `Traceback` | The program hit an error. | Copy the whole message and send it on — the last line is the useful part. |

---

## What is in this folder

```
mcp-server/
  README.md              <- this page
  src/
    server.py            <- the server itself
  artifacts/
    week-05/             <- empty, for your Inspector recording later
```

`artifacts/week-05/` is intentionally empty for now.

---

## What this server can do

It has **one tool**, called `get_safari_details`.

You give it a destination ID like `SF-300`, and it asks the travel backend for
that destination's name, country, length and price.

It still has no **resources** (readable data) and no **prompts** (saved
workflows). Those come later.

### What it answers

Every answer includes a `status`, and that word is the important part:

| status | What it means | What to do |
|---|---|---|
| `ok` | Found it, and name, country, duration and price are **all checked as present**. | Safe to use and quote. |
| `incomplete` | Real destination, unfinished record. | **Do not quote a price or duration.** An advisor was notified automatically. |
| `unsupported` | We do not sell this destination. | Do not invent details. An advisor was notified. |
| `unavailable` | The backend could not be reached. | Says nothing about the destination. Try again shortly. |
| `bad_response` | The backend answered, but the answer was incomplete or malformed, so it was refused. | **Do not retry** — it will say the same thing. A person needs to look at the backend. |
| `not_configured` | This server is missing its token. | A person must fix it. Retrying will not help. |

**Why `bad_response` exists.** `ok` is a promise that the details are complete
and safe to put in front of a customer. Earlier, the server repeated that
promise without checking — so a backend replying "ok" with an empty record
produced a confident answer with every field blank, and because it was not an
error, nobody would have noticed. The details are now checked before `ok` is
reported.

### Bad input is refused before anything happens

The ID must be letters, numbers and hyphens only. If you pass a name instead —
`"Serengeti Migration Safari"` — the request is rejected immediately, before the
backend is contacted at all:

```
String should match pattern '^[A-Za-z0-9-]{1,64}$'
```

This is deliberate. A malformed ID is refused here rather than being sent across
the network to be refused there.

### What happens when the backend is down

The tool does **not** crash, and the server does **not** hang. It answers:

```json
{
  "status": "unavailable",
  "destination_id": "SF-300",
  "message": "Could not reach the travel backend at http://127.0.0.1:3001.
              It is most likely not running."
}
```

It comes back in about **two seconds** rather than waiting forever, because the
program has a time limit built into it. When the backend comes back, the tool
starts working again on its own — this server does not need restarting.

---

## What this server assumes

Everything the server holds on to between calls is listed here, so it is known
rather than hidden. There are only three things, and **none of them is written
to after the server starts** — which is why none of them can get muddled when
two people use it at once.

### 1. The backend address and token

Read once, when the server starts, from the two lines you typed in the terminal.
They are then fixed for as long as it runs.

- **Two calls at the same time:** no problem. Both read the same value, and
  nothing ever changes it.
- **The server restarts mid-call:** the call in progress is lost and the caller
  sees a dropped connection. On starting again, both values are read fresh from
  the terminal — **and if you opened a new terminal window, they are gone**, so
  you must type them again.
- **Worth knowing:** if you point this at the wrong backend, it will answer
  confidently from the wrong data and nothing will look broken. The server
  prints which backend it is using on the line `backend: ...` when it starts.
  Read that line.

### 2. The connection sessions with clients

When a client connects, the MCP library gives it a session and remembers it in
the server's memory.

- **Two calls at the same time:** no problem. Each request carries its own
  session, and they do not touch each other.
- **The server restarts mid-call:** **every session disappears.** Connected
  clients must reconnect. This is the most visible effect of a restart, and it
  is normal — clients are expected to handle it.

### 3. The connection to the travel backend

A fresh one is opened for each call and closed when that call finishes. Nothing
is kept.

- **Two calls at the same time:** two separate connections. They cannot
  interfere.
- **The server restarts mid-call:** the connection is dropped. Because the tool
  only *reads*, nothing is left half-finished at the other end.

### What is deliberately NOT here

No saved files, no cached answers, no counters, no database, no log file it
appends to. Nothing accumulates. If you stop the server and start it again, it
behaves exactly as it did the first time.

**This will change the moment a tool is added that writes something.** At that
point the server will need to remember what it has already done, so that a
retry does not do it twice — and that memory has to survive a restart, which
means a real file or database rather than a value in memory.

---

## A note about the Inspector

There is a visual testing tool for MCP servers called the Inspector, which opens
in a browser.

The old blocker no longer applies. Previously the Inspector could not be used
here, because it worked by launching the server itself as a second program, and
that needed a configuration file this folder does not have. Now that the server
is reached at an address, the Inspector can simply connect to it instead of
launching it — you start the server yourself using the two lines above, then
point the Inspector at:

```
http://127.0.0.1:8000/mcp
```

choosing **Streamable HTTP** as the connection type.

This has not been tried yet on this machine, so treat it as expected-to-work
rather than confirmed. When it does connect you should see one tool,
`get_safari_details`, and no resources or prompts.

---

## One rule if you open `server.py`

The old rule on this page said never to use `print(...)` in that file. **That
rule no longer applies.** It existed because of the old setup, where the server
talked to its client through the same channel `print` writes to, so a stray
`print` garbled the conversation. Now that the server talks over an address
instead, `print` is harmless.

---

## About other people using this

Right now the server is locked to this computer. The address `127.0.0.1` in
`server.py` is what does the locking.

It is tempting to change that one value to `0.0.0.0` to let colleagues in.
**Do not.** That value means "anyone who can reach this machine", and this
server currently has no way of checking who is calling — so anyone who found it
could use it freely.

Letting other people in needs three things that do not exist yet:

1. A computer that stays switched on and hosts the server, rather than your
   laptop.
2. A way of checking that a caller is allowed in — a lock on the door.
3. A way of checking *which* caller it is, so that one person cannot see
   another person's information.

Those are a real piece of work, not a settings change. Ask for them when you
are ready to open it up.

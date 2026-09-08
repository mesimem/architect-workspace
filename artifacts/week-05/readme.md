# mcp-server

An MCP server, built in **Python**. Right now it is deliberately empty: it starts,
it can say "hello, I exist", and that is all. Nothing has been added to it yet.

This page tells you how to start it and what you should see. You do not need to
know any programming to follow it.

---

## What "starting the server" actually means

An MCP server is not a website. Nothing opens in your browser, and there is no
address to visit. It is a small program that sits in your terminal window and
waits to be spoken to by a *client* (for example Claude Code).

So when you start it, the correct outcome is:

1. One line of text appears.
2. Then nothing else happens, and the window just sits there.

**Step 2 is not a problem.** A window that sits there quietly is a server that is
running properly and waiting. If it printed lots of text at you, something would
be wrong.

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

Open a terminal (PowerShell). Type these two lines, pressing Enter after each.

**Line 1 — move into the right folder:**

```
cd C:\Users\Mems\Documents\AI-Project\mcp-server
```

**Line 2 — start the server:**

```
uv run --with "mcp[cli]" python src/server.py
```

The quote marks around `"mcp[cli]"` matter. Please type it exactly as shown.

---

## Exactly what you should see

Within a second or two, this single line appears:

```
my-mcp-server is running. Press Ctrl+C to stop.
```

That is the confirmation. The server is up.

**On the very first run only**, you may see one extra line *above* it, like:

```
Installed 38 packages in 333ms
```

That is `uv` fetching the MCP software the first time. It is normal, it happens
once, and you can ignore it.

After that line, the cursor sits on an empty line and nothing further happens.
**That is success.** Leave the window open for as long as you want the server
running.

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
| A window flashes open and shuts instantly | You double-clicked `server.py` instead of using a terminal. | This program can only be started from a terminal, using the two lines above. |
| Nothing at all appears, not even one line | The command did not run. | Check for a typo in Line 2, especially the quote marks around `"mcp[cli]"`. |
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

## What this server cannot do yet

Nothing has been added to it. In MCP terms it has no **tools** (actions), no
**resources** (readable data) and no **prompts** (saved workflows). A client can
connect to it and will correctly report that it offers nothing.

That is the intended state. The plumbing is proven first; features come next.

---

## A note about the Inspector

There is a visual testing tool for MCP servers called the Inspector, which opens
in a browser. **It does not work against this folder yet**, and that is expected
rather than broken.

The reason: the Inspector re-launches the server as a second, separate program,
and to do that it needs a project configuration file that this folder does not
have — because the folder was deliberately kept to the three items listed above
and nothing else.

Adding the Inspector is a small, separate change (one extra file). It has been
left out on purpose so this folder matches exactly what was asked for. Ask for it
when you want to make your `artifacts/week-05/` recording.

---

## One rule if you open `server.py`

Never add a `print(...)` to that file, unless it ends with `, file=sys.stderr`
like the existing one does. A plain `print` writes into the same channel the
server uses to talk to its client, which garbles the conversation and makes the
client disconnect with a confusing error. The file repeats this warning at the
top.

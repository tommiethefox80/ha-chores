# Chores – Home Assistant add-on

A small chores and pocket-money tracker. Zero dependencies (Node + built-in SQLite), one container, runs inside Home Assistant via Ingress.

## Install (HA OS)

1. Copy this folder to `/addons/chores` on the HA box (Samba share, SSH add-on, or the File editor – the folder is `addons` next to `config`).
2. Settings → Add-ons → Add-on Store → ⋮ (top right) → **Check for updates**.
3. Scroll to **Local add-ons**, open **Chores**, Install, Start. It appears in the sidebar as **Chores**.

Data is stored in the add-on's `/data/chores.db`, which is included in HA backups.

## How sign-in works

Ingress tells the add-on which HA user opened it:

- First ever visit: whoever opens it sets the **parent PIN** and their HA username is recorded as a parent.
- HA users listed under Settings → *Parent Home Assistant users* go straight to the parent view.
- A child with their HA username set on their record goes straight to their own view.
- Anyone else (e.g. the generic kitchen-tablet user) gets a PIN pad: the parent PIN opens the parent view, a child's PIN opens theirs. The session lasts 12 hours or until **Lock** is tapped.

## Model

- **Chore** – price (can be £0 if it only counts towards a goal), frequency (every day / certain days / once a week / any time), and whether a grown-up must check it before it counts.
- **Goal** – "do *N* chores each week or month and earn £X". Optionally restricted to a chosen set of chores. The reward is added to the balance once the period has ended and the target was met.
- **Balance** = approved chore values + earned goal rewards − payouts.

## Local run

```
node --experimental-sqlite server.js
```
Then open http://localhost:8099. Without Ingress headers you'll be sent to the PIN pad; add `X-Remote-User-Name: <name>` to simulate an HA user.

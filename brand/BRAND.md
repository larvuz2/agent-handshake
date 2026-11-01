# Agent Handshake brand

**Name:** Agent Handshake. Two words, both capitalized. Never "AgentHandshake" or "AH".

**Line:** Add to my agent. Three clicks, zero pasting.

**Short description:** `npm install` for agents, with a free trial, a wallet, and an uninstall button.

## The mark

Two linked loops: the service and the agent, joined. The blue loop passes over the green one at the top and under it at the bottom, so they read as linked, not just overlapping.

| File | Use |
|---|---|
| [`mark.svg`](mark.svg) | The mark alone: favicons, app icons, avatars |
| [`logo.svg`](logo.svg) | Mark and wordmark: headers, READMEs |

Keep space around the mark equal to the height of one loop. Don't recolor the loops separately, rotate them, or add effects. On dark or blue backgrounds, use the one-color version (white and light blue) that the button uses.

## Colors

| Token | Light | Dark | Use |
|---|---|---|---|
| Ink | `#0B1020` | `#EEF1F8` | Text |
| Handshake Blue | `#2B59FF` | `#5B7FFF` | Primary actions, the button, the blue loop |
| Mint | `#12B886` | `#2FD3A0` | Trials, "working great", the green loop |
| Amber | `#B7791F` | `#F2B54B` | Spend, warnings, "unused" |
| Coral | `#E5484D` | `#FF6B70` | Remove, errors |
| Soft background | `#F5F7FB` | `#121827` | Panels |
| Line | `#E4E7EF` | `#262C3D` | Borders |

All tokens are CSS variables in [`handshake.css`](handshake.css) (`--ah-blue`, `--ah-mint`, ...), with a dark theme.

## Type

The system UI font stack (San Francisco, Segoe UI, Roboto...). No web fonts, so pages load fast and work offline. Headlines are heavy (750–780) with slightly tight letter spacing (-0.02em).

## The button

The "Add to my agent" button is a blue pill with the one-color mark and the words **Add to my agent**. Use it as is:

- Website: `<script src="https://<gateway>/button.js" data-service="<id>" async></script>`
- README or anywhere images work: `https://<gateway>/badge/<id>.svg` linked to `https://<gateway>/add/<id>`
- Dark variant: `https://<gateway>/badge/<id>.svg?theme=dark`

## Voice

Plain words, short sentences. Say what happens: "Start free trial", "Remove", "Spend limit: $0". Every technical detail goes in a small **Behind the scenes** box, so the page works for non-technical people and is still useful to developers.

// One install link in, the right deep link out for each agent app.
// Install links are public URLs: they carry a name and a server URL, never a secret.
// Formats checked against vendor docs (Nov 2026). See docs/hosts.md.

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * @param {{ name: string, url: string, title?: string, description?: string }} server
 *   name: short machine name (e.g. "lumen-video"); title: display name.
 * @returns {Array<{id,name,note?,kind,href?,command?,config?,steps:string[]}>}
 */
export function installTargets({ name, url, title, description }) {
  const display = title || name;
  const enc = encodeURIComponent;
  const remote = b64(JSON.stringify({ url }));

  return [
    {
      id: 'claude',
      name: 'Claude',
      note: 'claude.ai, Desktop and mobile',
      kind: 'link',
      href: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${enc(display)}&connectorUrl=${enc(url)}`,
      steps: ['Click "Add" in the Claude window that opens.', 'Click "Connect". You will see the free-trial screen.'],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      note: 'Terminal',
      kind: 'command',
      command: `claude mcp add --transport http ${name} ${url}`,
      steps: ['Run the command in your terminal.', 'In Claude Code, run /mcp, pick the server and choose "Authenticate".'],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      kind: 'link',
      href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${enc(name)}&config=${enc(remote)}`,
      config: { mcpServers: { [name]: { url } } },
      steps: ['Click "Install" in Cursor.', 'Click "Needs login" next to the server to see the free-trial screen.'],
    },
    {
      id: 'vscode',
      name: 'VS Code',
      note: 'Copilot agent mode',
      kind: 'link',
      href: `vscode:mcp/install?${enc(JSON.stringify({ name, type: 'http', url }))}`,
      command: `code --add-mcp '${JSON.stringify({ name, type: 'http', url })}'`,
      config: { servers: { [name]: { type: 'http', url } } },
      steps: ['Click "Install" in VS Code.', 'Allow the sign-in when VS Code asks. You will see the free-trial screen.'],
    },
    {
      id: 'goose',
      name: 'Goose',
      kind: 'link',
      href: `goose://extension?url=${enc(url)}&type=streamable_http&id=${enc(name)}&name=${enc(display)}${description ? `&description=${enc(description.slice(0, 200))}` : ''}`,
      steps: ['Confirm the extension in Goose.', 'Sign in when Goose opens the browser.'],
    },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      kind: 'link',
      href: `lmstudio://add_mcp?name=${enc(name)}&config=${enc(remote)}`,
      steps: ['Confirm the server in LM Studio.', 'Sign in when asked.'],
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      note: 'Developer mode',
      kind: 'manual',
      steps: [
        'In ChatGPT settings, open Connectors and turn on Developer mode.',
        'Create a connector, paste the server URL below, and choose OAuth.',
      ],
    },
    {
      id: 'other',
      name: 'Another app',
      note: 'Any app with remote MCP',
      kind: 'manual',
      config: { mcpServers: { [name]: { type: 'http', url } } },
      steps: ['Add a remote MCP server (Streamable HTTP) with the URL below.', 'Sign in with OAuth when asked. No API key needed.'],
    },
  ];
}

// Flat map, handy for READMEs and the CLI.
export function installLinks(server) {
  const out = {};
  for (const t of installTargets(server)) {
    if (t.href) out[t.id] = t.href;
    else if (t.command) out[t.id] = t.command;
  }
  return out;
}

// Proposed custom scheme for hosts that read Agent Handshake terms natively.
// agent-handshake://install?card=<url of the server card>
export function handshakeSchemeLink(cardUrl) {
  return `agent-handshake://install?card=${encodeURIComponent(cardUrl)}`;
}

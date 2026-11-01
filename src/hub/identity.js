// The hub is the one MCP connection that gives an agent every tool on this gateway.
// It lives at /mcp. Inside the OAuth code it's treated like a service with this id.

export const HUB_ID = '_hub';

export function hubService(config) {
  return {
    id: HUB_ID,
    name: `${hostName(config.publicUrl)}/hub`,
    title: config.name,
    description: 'One connection to every tool here. Your agent can find, try and use them.',
    version: '0.2.0',
    publisher: { name: config.name, domain: new URL(config.publicUrl).hostname },
    scopes: {},
    plans: [{ id: 'hub', title: 'Free', price: 0, limits: {}, scopes: ['*'] }],
    hub: true,
  };
}

// "agents.example.com" -> "com.example.agents" (one "/" is added by the caller)
export function hostName(publicUrl) {
  const host = new URL(publicUrl).hostname;
  return host.split('.').reverse().join('.') || 'local';
}

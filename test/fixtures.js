export const LUMEN_TOOLS_FOR_TEST = [
  { name: 'list_projects', description: 'List your Lumen Video projects.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_project', description: 'Create a video project from a prompt.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } },
];

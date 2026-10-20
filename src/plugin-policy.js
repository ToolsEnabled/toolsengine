// Vendor distribution is an explicit ceiling; standalone MCP keeps its own modes.
export const OPENAI_PLUGIN_TOOLS = Object.freeze([
  'workspace.list', 'workspace.read_file', 'workspace.write_file', 'workspace.search',
  'web.fetch', 'web.extract', 'system.status', 'capability.find',
]);
export function assertPluginProfile(config) {
  if (config.pluginProfile === undefined) return;
  if (config.pluginProfile !== 'openai') throw new Error('Unknown ToolsEngine plugin profile.');
  if (config.browser !== false || config.desktopProfileRoot || config.desktopAllowSignIn
      || config.profileDir || config.cdpEndpoint || config.browserExtension || config.firefoxDesktop
      || config.browserExecutable || config.browserChannel || config.browserSandbox === false
      || config.allowLocalNetwork || config.desktopLeftHalf)
    throw new Error('The OpenAI plugin profile permits only scoped files and public web; browser, desktop, sign-in and private-network options are refused.');
}
export function restrictPluginTools(tools, profile) {
  if (profile === undefined) return tools;
  if (profile !== 'openai') throw new Error('Unknown ToolsEngine plugin profile.');
  return tools.filter(tool => OPENAI_PLUGIN_TOOLS.includes(tool.name));
}

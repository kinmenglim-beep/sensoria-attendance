/** Read a config value from Workers env bindings, falling back to process.env on Node. */
export function envVar(c, name) {
  const v = c.env && typeof c.env[name] === 'string' ? c.env[name] : undefined;
  return v ?? globalThis.process?.env?.[name];
}

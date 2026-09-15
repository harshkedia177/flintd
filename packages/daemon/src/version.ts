// What every MCP client caches as this server's version. The publish workflow refuses a release the string
// disagrees with, and a gate test refuses a string that has drifted from the manifest of this package.
export const VERSION = "0.1.0"

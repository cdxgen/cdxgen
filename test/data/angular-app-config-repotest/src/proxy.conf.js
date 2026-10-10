// Dev-server proxy that routes through a corporate proxy when one is set.
// https-proxy-agent is a devDependency used only here, so it must not be
// scoped required: proxy.conf.js is still skipped by the default ignore
// pattern.
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyConfig = [
  {
    context: ['/api'],
    target: 'http://localhost:3000',
    secure: false
  }
];

function setupForCorporateProxy(config) {
  const proxyServer = process.env.http_proxy || process.env.HTTP_PROXY;
  if (proxyServer) {
    const agent = new HttpsProxyAgent(proxyServer);
    for (const entry of config) {
      entry.agent = agent;
    }
  }
  return config;
}

module.exports = setupForCorporateProxy(proxyConfig);

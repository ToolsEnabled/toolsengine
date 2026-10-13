import { createWebTools } from '../src/web.js';
const fetch = createWebTools().find(tool => tool.name === 'web.fetch');
const result = await fetch.handler({ url: 'https://example.com/' });
console.log(JSON.stringify({ platform: process.platform, status: result.status, fields: Object.keys(result), bytes: result.bytes, success: true }));

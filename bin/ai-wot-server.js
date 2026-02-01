#!/usr/bin/env node
// ai-wot REST API Server
// Usage: ai-wot-server [--port 3000]

const { createServer } = require('../lib/server');

const args = process.argv.slice(2);
let port = process.env.AI_WOT_PORT || 3000;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    port = parseInt(args[++i], 10);
  }
}

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   ai-wot REST API Server                            ║');
console.log('║   Web of Trust for AI Agents on Nostr                ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

const { start } = createServer({ port });

start().then(() => {
  console.log('  Press Ctrl+C to stop.\n');
}).catch(err => {
  console.error(`❌ Failed to start server: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});
